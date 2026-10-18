<?php
/* routes/auth.js */

function sign_token($user) {
    return jwt_sign(['id' => $user['id'], 'role' => $user['role']], 30 * 24 * 3600);
}
function bcrypt_hash($password) {
    return password_hash((string)$password, PASSWORD_BCRYPT, ['cost' => 10]);
}

// POST /api/auth/register (client signup — status starts pending_payment)
route('POST', '/register', function () {
    $name = in_body('name'); $email = in_body('email'); $phone = in_body('phone');
    $password = in_body('password'); $referralCode = in_body('referralCode');
    if (!truthy($name) || !truthy($email) || !truthy($password)) respond(400, ['error' => 'Name, email and password are required']);
    $email = strtolower($email);
    if (find_one('users', ['email' => $email])) respond(409, ['error' => 'An account with this email already exists']);

    $referredBy = null;
    if (truthy($referralCode)) {
        $referrer = find_one('users', ['referralCode' => strtoupper(trim($referralCode))]);
        if ($referrer) $referredBy = $referrer['id'];
    }
    $user = create('users', [
        'name' => $name, 'email' => $email, 'phone' => $phone, 'passwordHash' => bcrypt_hash($password),
        'role' => 'client', 'referralCode' => unique_referral_code($name), 'referredBy' => $referredBy
    ]);
    respond(201, ['token' => sign_token($user), 'user' => safe_user($user)]);
}, ['err' => 'Registration failed']);

// POST /api/auth/create-first-admin — one-shot bootstrap, only if no admin exists
route('POST', '/create-first-admin', function () {
    if (find_one('users', ['role' => 'admin'])) respond(403, ['error' => 'An admin already exists. This endpoint is disabled.']);
    $name = in_body('name'); $email = in_body('email'); $password = in_body('password');
    if (!truthy($name) || !truthy($email) || !truthy($password)) respond(400, ['error' => 'Name, email and password are required']);
    if (strlen($password) < 6) respond(400, ['error' => 'Password must be at least 6 characters']);
    $admin = create('users', [
        'name' => $name, 'email' => strtolower($email), 'passwordHash' => bcrypt_hash($password),
        'role' => 'admin', 'status' => 'active', 'tier' => 'none'
    ]);
    respond(201, ['user' => safe_user($admin)]);
}, ['err' => 'Could not create admin']);

// POST /api/auth/login
route('POST', '/login', function () {
    $email = in_body('email'); $password = in_body('password');
    if (!truthy($email) || !truthy($password)) respond(400, ['error' => 'Email and password required']);
    $user = find_one('users', ['email' => strtolower($email)]);
    if (!$user) respond(401, ['error' => 'Invalid email or password']);
    if (!password_verify((string)$password, $user['passwordHash'])) respond(401, ['error' => 'Invalid email or password']);
    if ($user['role'] === 'admin' && $user['status'] === 'pending_approval') {
        respond(403, ['error' => 'Your coach/admin account is pending approval. It has not been activated yet.']);
    }
    return ['token' => sign_token($user), 'user' => safe_user($user)];
}, ['err' => 'Login failed']);

// GET /api/auth/me
route('GET', '/me', function () {
    require_auth();
    return ['user' => safe_user(me())];
});

// POST /api/auth/request-admin — creates a pending_approval admin account
route('POST', '/request-admin', function () {
    $name = in_body('name'); $email = in_body('email'); $password = in_body('password');
    if (!truthy($name) || !truthy($email) || !truthy($password)) respond(400, ['error' => 'Name, email and password are required']);
    if (strlen($password) < 6) respond(400, ['error' => 'Password must be at least 6 characters']);
    if (find_one('users', ['email' => strtolower($email)])) respond(409, ['error' => 'An account with this email already exists']);
    $admin = create('users', [
        'name' => $name, 'email' => strtolower($email), 'passwordHash' => bcrypt_hash($password),
        'role' => 'admin', 'status' => 'pending_approval', 'tier' => 'none'
    ]);
    respond(201, ['requested' => true, 'email' => $admin['email']]);
}, ['err' => 'Could not submit request']);
