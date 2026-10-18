<?php
/* ============================================================
   FastCoach PHP backend — core: config, DB, row mapping, HTTP,
   JWT, and small JS-compatible helpers.

   The database layout is IDENTICAL to the old Node/Sequelize app
   (snake_case columns, UTC datetimes), and every API response uses
   the same camelCase JSON shape, so the existing frontend works
   unchanged and an existing database can be imported as-is.
   ============================================================ */

/* ---------------- config ---------------- */
function cfg($key, $default = null) {
    static $c = null;
    if ($c === null) {
        $file = __DIR__ . '/../config.php';
        $c = file_exists($file) ? (require $file) : [];
    }
    if (array_key_exists($key, $c) && $c[$key] !== '' && $c[$key] !== null) return $c[$key];
    $env = getenv($key);
    return ($env !== false && $env !== '') ? $env : $default;
}

/** The timezone used for calendar-day maths (programme day, due dates). */
function app_tz() {
    static $tz = null;
    if (!$tz) $tz = new DateTimeZone(cfg('APP_TIMEZONE', 'Asia/Kolkata'));
    return $tz;
}

/* ---------------- DB ---------------- */
function db() {
    static $pdo = null;
    if ($pdo) return $pdo;
    $dsn = sprintf('mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4',
        cfg('DB_HOST', 'localhost'), cfg('DB_PORT', '3306'), cfg('DB_NAME', ''));
    $opts = [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => true,
    ];
    if (strtolower((string)cfg('DB_SSL', 'false')) === 'true') {
        $opts[PDO::MYSQL_ATTR_SSL_VERIFY_SERVER_CERT] = false;
        $opts[PDO::MYSQL_ATTR_SSL_CA] = cfg('DB_SSL_CA', '');
    }
    $pdo = new PDO($dsn, cfg('DB_USER', ''), cfg('DB_PASSWORD', ''), $opts);
    // All datetimes are stored in UTC, exactly as the Node app stored them.
    $pdo->exec("SET time_zone = '+00:00'");
    return $pdo;
}

function q($sql, $params = []) {
    $st = db()->prepare($sql);
    $st->execute(array_values($params));
    return $st;
}

/** Creates any missing table on first run (like the Node app did on boot). */
function ensure_schema() {
    $exists = q("SELECT COUNT(*) c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'users'")->fetch()['c'];
    if ((int)$exists) return;
    $sql = file_get_contents(__DIR__ . '/../../install/schema.sql');
    db()->exec('SET FOREIGN_KEY_CHECKS = 0');
    foreach (array_filter(array_map('trim', explode(";\n", $sql))) as $stmt) {
        if ($stmt !== '') db()->exec($stmt);
    }
    db()->exec('SET FOREIGN_KEY_CHECKS = 1');
}

/* ---------------- time helpers ---------------- */
function now_db() { return gmdate('Y-m-d H:i:s'); }

/** DB UTC datetime -> "2026-10-17T10:24:54.000Z" (what Sequelize sent). */
function iso($dbval) {
    if ($dbval === null || $dbval === '') return null;
    $d = new DateTime($dbval, new DateTimeZone('UTC'));
    return $d->format('Y-m-d\TH:i:s.v\Z');
}

/** Anything a browser sends (ISO string) -> DB UTC datetime, or null if unparseable. */
function to_db_datetime($val) {
    if ($val === null || $val === '') return null;
    // Already a DB-format UTC datetime (from now_db() or a DB row).
    if (is_string($val) && preg_match('/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/', $val)) return $val;
    try {
        if (is_numeric($val)) { $d = (new DateTime('@' . intval($val / 1000))); }
        else $d = new DateTime((string)$val, app_tz());
    } catch (Exception $e) { return null; }
    $d->setTimezone(new DateTimeZone('UTC'));
    return $d->format('Y-m-d H:i:s');
}

/** Unix seconds (float) for a DB UTC datetime. */
function ts($dbval) {
    if ($dbval === null) return null;
    // Accept DB strings and ISO strings alike.
    if (strpos($dbval, 'T') !== false) return (new DateTime($dbval))->getTimestamp();
    return (new DateTime($dbval, new DateTimeZone('UTC')))->getTimestamp();
}
function now_ts() { return microtime(true); }

/** Local calendar date (YYYY-MM-DD) in the app timezone. */
function local_date($when = 'now') {
    $d = $when instanceof DateTime ? clone $when : new DateTime(is_numeric($when) ? '@' . intval($when) : $when, new DateTimeZone('UTC'));
    $d->setTimezone(app_tz());
    return $d->format('Y-m-d');
}
function today_local() { return (new DateTime('now', app_tz()))->format('Y-m-d'); }

/** Whole days between two YYYY-MM-DD dates (b - a), like Math.round((b-a)/86400000). */
function day_diff($a, $b) {
    $da = new DateTime($a . ' 00:00:00', new DateTimeZone('UTC'));
    $dbb = new DateTime($b . ' 00:00:00', new DateTimeZone('UTC'));
    return (int)round(($dbb->getTimestamp() - $da->getTimestamp()) / 86400);
}
function add_days($date, $n) {
    $d = new DateTime($date . ' 00:00:00', new DateTimeZone('UTC'));
    $d->modify(($n >= 0 ? '+' : '') . (int)$n . ' days');
    return $d->format('Y-m-d');
}

/* ---------------- JS-compatible maths ---------------- */
function jsround($x) { return (int)floor($x + 0.5); }
function round1($x) { return jsround($x * 10) / 10; }
/** JS parseFloat: leading number of a string, or null (NaN). */
function js_float($v) {
    if (is_int($v) || is_float($v)) return (float)$v;
    if (is_bool($v) || $v === null) return null;
    if (preg_match('/^\s*([+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/', (string)$v, $m)) return (float)$m[1];
    return null;
}
function js_int($v) {
    if (is_int($v)) return $v;
    if (is_float($v)) return (int)$v;
    if (is_bool($v) || $v === null) return null;
    if (preg_match('/^\s*([+-]?\d+)/', (string)$v, $m)) return (int)$m[1];
    return null;
}
/** JS truthiness for request values. */
function truthy($v) { return !($v === null || $v === false || $v === 0 || $v === 0.0 || $v === '' || (is_float($v) && is_nan($v))); }

/* ---------------- schema metadata + row mapping ---------------- */
function schema_meta() {
    static $m = null;
    if ($m === null) $m = json_decode(file_get_contents(__DIR__ . '/../data/schema.json'));
    return $m;
}
function cols($table) { return schema_meta()->$table->cols; }

/** One DB row -> the camelCase JSON object Sequelize produced. */
function out($table, $row) {
    if (!$row) return null;
    $res = [];
    foreach (cols($table) as $attr => $c) {
        if (!array_key_exists($c->col, $row)) continue;
        $v = $row[$c->col];
        if ($v === null) { $res[$attr] = null; continue; }
        switch ($c->type) {
            case 'int': $v = (int)$v; break;
            case 'float': $v = (float)$v; break;
            case 'bool': $v = (bool)(int)$v; break;
            case 'json': $v = json_decode($v); break;
            case 'datetime': $v = iso($v); break;
            default: $v = (string)$v;
        }
        $res[$attr] = $v;
    }
    return $res;
}
function outs($table, $rows) { return array_map(fn($r) => out($table, $r), $rows); }

/** camelCase value -> DB value for writing. */
function to_db($table, $attr, $v) {
    $c = cols($table)->$attr;
    if ($v === null) return null;
    switch ($c->type) {
        case 'bool': return $v ? 1 : 0;
        case 'json': return json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        case 'datetime': return to_db_datetime($v);
        case 'int': return is_bool($v) ? (int)$v : (is_numeric($v) ? (int)round((float)$v) : $v);
        case 'float': return is_numeric($v) ? (float)$v : $v;
        default: return is_bool($v) ? ($v ? '1' : '0') : (string)$v;
    }
}

/** Build "a = ? AND b IS NULL" from ['attr' => value]. */
function where_sql($table, $where, &$params) {
    $parts = [];
    $c = cols($table);
    foreach ($where as $attr => $val) {
        $col = '`' . $c->$attr->col . '`';
        if ($val === null) $parts[] = "$col IS NULL";
        elseif (is_array($val)) {
            if (!$val) { $parts[] = '0'; continue; }
            $parts[] = "$col IN (" . implode(',', array_fill(0, count($val), '?')) . ')';
            foreach ($val as $v) $params[] = to_db($table, $attr, $v);
        } else { $parts[] = "$col = ?"; $params[] = to_db($table, $attr, $val); }
    }
    return $parts ? implode(' AND ', $parts) : '1';
}
function order_sql($table, $order) {
    if (!$order) return '';
    $c = cols($table);
    $o = [];
    foreach ($order as $pair) $o[] = '`' . $c->{$pair[0]}->col . '` ' . (strtoupper($pair[1] ?? 'ASC') === 'DESC' ? 'DESC' : 'ASC');
    return ' ORDER BY ' . implode(', ', $o);
}

function find_all($table, $where = [], $order = null, $limit = null, $extraSql = '', $extraParams = []) {
    $params = [];
    $sql = "SELECT * FROM `$table` WHERE " . where_sql($table, $where, $params) . $extraSql . order_sql($table, $order);
    if ($limit) $sql .= ' LIMIT ' . (int)$limit;
    return outs($table, q($sql, array_merge($params, $extraParams))->fetchAll());
}
function find_one($table, $where = [], $order = null) {
    $r = find_all($table, $where, $order, 1);
    return $r ? $r[0] : null;
}
function find_pk($table, $id) {
    if ($id === null || $id === '' || !is_numeric($id)) return null;
    return find_one($table, ['id' => (int)$id]);
}
function count_rows($table, $where = []) {
    $params = [];
    return (int)q("SELECT COUNT(*) c FROM `$table` WHERE " . where_sql($table, $where, $params), $params)->fetch()['c'];
}

/** Insert with model defaults applied (like Sequelize create); returns the stored row. */
function create($table, $attrs) {
    $now = now_db();
    $cols = [];
    $vals = [];
    foreach (cols($table) as $attr => $c) {
        if ($attr === 'id') continue;
        if ($attr === 'createdAt' || $attr === 'updatedAt') { $cols[] = $c->col; $vals[] = $now; continue; }
        if (array_key_exists($attr, $attrs)) $v = to_db($table, $attr, $attrs[$attr]);
        elseif (property_exists($c, 'default')) {
            $v = $c->default === '__NOW__' ? $now : to_db($table, $attr, $c->default);
        } else continue;
        $cols[] = $c->col; $vals[] = $v;
    }
    $sql = "INSERT INTO `$table` (`" . implode('`,`', $cols) . "`) VALUES (" . implode(',', array_fill(0, count($cols), '?')) . ')';
    q($sql, $vals);
    return find_pk($table, db()->lastInsertId());
}

/** Write changed attributes of $row back (like instance.save()). Returns the fresh row. */
function save($table, $row, $changes) {
    $c = cols($table);
    $sets = []; $vals = [];
    foreach ($changes as $attr => $v) {
        if (!isset($c->$attr) || $attr === 'id') continue;
        $sets[] = '`' . $c->$attr->col . '` = ?';
        $vals[] = to_db($table, $attr, $v);
    }
    if (!$sets) return $row;
    $sets[] = '`updated_at` = ?'; $vals[] = now_db();
    $vals[] = $row['id'];
    q("UPDATE `$table` SET " . implode(', ', $sets) . ' WHERE id = ?', $vals);
    return find_pk($table, $row['id']);
}
function destroy($table, $where) {
    $params = [];
    q("DELETE FROM `$table` WHERE " . where_sql($table, $where, $params), $params);
}

/* ---------------- HTTP ---------------- */
class HttpResponse extends Exception {
    public $status; public $payload;
    function __construct($status, $payload) { parent::__construct('response'); $this->status = $status; $this->payload = $payload; }
}
/** Send a JSON response and stop the route (thrown so nested helpers can respond too). */
function respond($status, $payload) { throw new HttpResponse($status, $payload); }
function json_out($status, $payload) {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION);
}

function body() {
    static $b = null;
    if ($b === null) {
        $raw = file_get_contents('php://input');
        $b = $raw ? json_decode($raw, true) : [];
        if (!is_array($b)) $b = [];
    }
    return $b;
}
function in_body($k) { $b = body(); return array_key_exists($k, $b) ? $b[$k] : null; }
function has_body($k) { return array_key_exists($k, body()); }
function qparam($k) { return isset($_GET[$k]) ? $_GET[$k] : null; }

function auth_header() {
    foreach (['HTTP_AUTHORIZATION', 'REDIRECT_HTTP_AUTHORIZATION'] as $k) if (!empty($_SERVER[$k])) return $_SERVER[$k];
    if (function_exists('getallheaders')) foreach (getallheaders() as $k => $v) if (strtolower($k) === 'authorization') return $v;
    return '';
}

/* ---------------- JWT (HS256, same format as jsonwebtoken) ---------------- */
function b64url($s) { return rtrim(strtr(base64_encode($s), '+/', '-_'), '='); }
function b64url_dec($s) { return base64_decode(strtr($s, '-_', '+/') . str_repeat('=', (4 - strlen($s) % 4) % 4)); }
function jwt_secret() {
    $s = cfg('JWT_SECRET');
    if (!$s) respond(500, ['error' => 'Server misconfigured', 'detail' => 'JWT_SECRET is not set in api/config.php']);
    return $s;
}
function jwt_sign($payload, $ttlSeconds) {
    $now = time();
    $payload = array_merge($payload, ['iat' => $now, 'exp' => $now + $ttlSeconds]);
    $h = b64url(json_encode(['alg' => 'HS256', 'typ' => 'JWT']));
    $p = b64url(json_encode($payload));
    return "$h.$p." . b64url(hash_hmac('sha256', "$h.$p", jwt_secret(), true));
}
function jwt_verify($token) {
    $parts = explode('.', $token);
    if (count($parts) !== 3) return null;
    [$h, $p, $s] = $parts;
    if (!hash_equals(b64url(hash_hmac('sha256', "$h.$p", jwt_secret(), true)), $s)) return null;
    $payload = json_decode(b64url_dec($p), true);
    if (!$payload || (isset($payload['exp']) && $payload['exp'] < time())) return null;
    return $payload;
}

/* ---------------- auth middleware ---------------- */
$CURRENT_USER = null;
function require_auth() {
    global $CURRENT_USER;
    $header = auth_header();
    $token = strpos($header, 'Bearer ') === 0 ? substr($header, 7) : null;
    if (!$token) respond(401, ['error' => 'Missing authentication token']);
    $payload = jwt_verify($token);
    if (!$payload) respond(401, ['error' => 'Invalid or expired token']);
    $user = find_pk('users', $payload['id'] ?? null);
    if (!$user) respond(401, ['error' => 'User no longer exists']);
    $CURRENT_USER = $user;
    return $user;
}
function require_role($role) {
    global $CURRENT_USER;
    if (!$CURRENT_USER || $CURRENT_USER['role'] !== $role) respond(403, ['error' => "$role access required"]);
}
function me() { global $CURRENT_USER; return $CURRENT_USER; }
/** Persist changes to the signed-in user and keep the in-memory copy current. */
function save_me($changes) { global $CURRENT_USER; $CURRENT_USER = save('users', $CURRENT_USER, $changes); return $CURRENT_USER; }
