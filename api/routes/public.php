<?php
/* Public routes (server.js): health, plans, site settings. */

// /api/health checks the database with a REAL query
route('GET', '/health', function () {
    $result = ['ok' => true, 'service' => 'fastcoach-backend'];
    try {
        db()->query('SELECT 1');
        $result['database'] = 'connected';
    } catch (Throwable $e) {
        respond(500, ['ok' => false, 'service' => 'fastcoach-backend', 'database' => 'NOT connected', 'error' => $e->getMessage()]);
    }
    try {
        $result['tablesCreated'] = true;
        $result['userCount'] = count_rows('users');
        $result['adminCount'] = count_rows('users', ['role' => 'admin']);
        $broken = 0;
        foreach (q('SELECT password_hash FROM users')->fetchAll() as $u) {
            if (!preg_match('/^\$2[aby]\$\d{2}\$/', $u['password_hash'] ?? '')) $broken++;
        }
        $result['usersWithBrokenPassword'] = $broken;
    } catch (Throwable $e) {
        $result['tablesCreated'] = false;
        $result['tableError'] = $e->getMessage();
    }
    return $result;
});

// Public: plans on landing page (PDF brochures left out — they can be several MB each)
route('GET', '/plans', function () {
    $order = [['order', 'ASC'], ['priceInr', 'ASC']];
    plans_seed_if_empty();
    $plans = find_all('plans', ['active' => true], $order);
    foreach ($plans as &$p) unset($p['brochurePdfBase64']);
    return ['plans' => $plans];
}, ['err' => 'Could not load plans']);

// Public: website name + logo
route('GET', '/site-settings', function () {
    try {
        $s = settings_get_or_create();
        return [
            'siteName' => $s['siteName'] ?: 'FastCoach',
            'logoBase64' => $s['logoBase64'] ?: null,
            // Public contact details — shown on the website and the app's sign-in page.
            'tagline' => $s['siteTagline'] ?? '',
            'coachName' => $s['coachName'] ?? '',
            'phone' => $s['phone'] ?? '',
            'whatsapp' => $s['whatsapp'] ?? '',
            'email' => $s['email'] ?? '',
            'address' => $s['address'] ?? '',
            'supportHours' => $s['supportHours'] ?? '',
            'instagramUrl' => $s['instagramUrl'] ?? '',
            'youtubeUrl' => $s['youtubeUrl'] ?? '',
            'showTestimonials' => array_key_exists('showTestimonials', $s) ? (bool)$s['showTestimonials'] : true,
        ];
    } catch (Throwable $e) {
        return ['siteName' => 'FastCoach', 'logoBase64' => null];
    }
});

// Public: success stories (before/after weight) for the landing page
route('GET', '/testimonials', function () {
    $s = settings_get_or_create();
    if (array_key_exists('showTestimonials', $s) && !$s['showTestimonials']) return ['testimonials' => []];
    return ['testimonials' => find_all('testimonials', ['active' => true], [['order', 'ASC'], ['id', 'DESC']])];
}, ['err' => 'Could not load testimonials']);
