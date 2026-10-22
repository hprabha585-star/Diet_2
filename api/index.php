<?php
/* ============================================================
   FastCoach API — single entry point. Every /api/* request is
   routed here by the .htaccess in the site root.
   ============================================================ */
require __DIR__ . '/lib/core.php';
require __DIR__ . '/lib/app.php';

ini_set('display_errors', '0');
error_reporting(E_ALL);

$ROUTES = [];
/**
 * route('GET', '/client/dashboard', fn($p) => [...], ['err' => 'Could not X'])
 * The handler returns an array (sent as 200 JSON) or calls respond().
 */
function route($method, $pattern, $handler, $opts = []) {
    global $ROUTES, $GROUP_MW, $GROUP_PREFIX;
    $pattern = $GROUP_PREFIX . $pattern;
    $regex = '#^' . preg_replace('#:([a-zA-Z]+)#', '(?P<$1>[^/]+)', $pattern) . '$#';
    $ROUTES[] = ['method' => $method, 'regex' => $regex, 'handler' => $handler, 'opts' => $opts, 'mw' => $GROUP_MW];
}
$GROUP_MW = null;
$GROUP_PREFIX = '';
/** Like router.use(...) in Express: middleware for every route under a prefix. */
$GROUPS = [];
function group($prefix, $mw, $file) {
    global $GROUP_MW, $GROUPS, $GROUP_PREFIX;
    $GROUPS[] = ['prefix' => $prefix, 'mw' => $mw];
    $GROUP_MW = $mw; $GROUP_PREFIX = $prefix;
    require $file;
    $GROUP_MW = null; $GROUP_PREFIX = '';
}

// Path after /api (works whether the site is in the domain root or a subfolder)
$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$pos = strpos($uri, '/api/');
$path = $pos === false ? '/' : substr($uri, $pos + 4);
$path = '/' . trim($path, '/');
$method = $_SERVER['REQUEST_METHOD'];

try {
    require __DIR__ . '/routes/public.php';
    group('/auth', null, __DIR__ . '/routes/auth.php');
    group('/client', function () { require_auth(); require_role('client'); }, __DIR__ . '/routes/client.php');
    group('/admin', function () { require_auth(); require_role('admin'); }, __DIR__ . '/routes/admin.php');
    group('/tracker', function () { require_auth(); require_role('client'); require_tracker(); }, __DIR__ . '/routes/tracker.php');

    // First run on a new database: create the tables automatically.
    ensure_schema();

    $matched = null; $params = [];
    foreach ($ROUTES as $r) {
        if ($r['method'] !== $method) continue;
        if (preg_match($r['regex'], $path, $m)) { $matched = $r; $params = array_filter($m, 'is_string', ARRAY_FILTER_USE_KEY); break; }
    }

    // Group middleware runs for any path under the prefix (Express router.use semantics).
    foreach ($GROUPS as $g) {
        if ($g['mw'] && ($path === $g['prefix'] || strpos($path, $g['prefix'] . '/') === 0)) { ($g['mw'])(); break; }
    }
    if (!$matched) respond(404, ['error' => 'Not found']);

    try {
        $result = ($matched['handler'])($params);
    } catch (HttpResponse $hr) {
        throw $hr;
    } catch (Throwable $e) {
        error_log('FastCoach route error: ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
        if (!empty($matched['opts']['err'])) respond(500, ['error' => $matched['opts']['err'], 'detail' => $e->getMessage()]);
        respond(500, ['error' => 'Internal server error']);
    }
    json_out(200, $result);
} catch (HttpResponse $hr) {
    json_out($hr->status, $hr->payload);
} catch (Throwable $e) {
    error_log('FastCoach error: ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    json_out(500, ['error' => 'Internal server error', 'detail' => $e->getMessage()]);
}
