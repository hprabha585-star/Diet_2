# FastCoach — deploy on MilesWeb (Premium web hosting)

This is the PHP version of FastCoach: same pages, same features, no Node.js
needed. It runs on MilesWeb's normal web hosting (PHP + MySQL).

```
public_html/
├── .htaccess            routes /api/* to PHP, everything else to the pages  (hidden file — must be uploaded)
├── index.html, app-login.html, client/, admin/, css/, js/
├── api/                 the API (index.php, lib/, routes/, data/)
│   └── config.sample.php → copy to config.php and fill in
├── install/schema.sql   tables (only used if the database is empty)
└── .github/workflows/deploy.yml   auto-upload to MilesWeb on every push
```

## 1. Create the MySQL database

MilesWeb control panel → **Databases → MySQL Databases** (in cPanel: *MySQL
Database Wizard*):
1. Create a database, e.g. `fastcoach`.
2. Create a user with a strong password.
3. Add the user to the database with **ALL PRIVILEGES**.

Write down the full names exactly as shown — the panel usually adds a prefix,
e.g. `abcd_fastcoach`. The host is `localhost`.

## 2. Set the PHP version

Control panel → **Select PHP Version** / **MultiPHP Manager** → choose
**PHP 8.2** (8.1 or newer works) for your domain. Make sure the extensions
**pdo_mysql**, **mbstring** and **openssl** are ticked (they normally are).

## 3. Put the code on GitHub and deploy

1. Create a **private** repository on GitHub (e.g. `fastcoach`) and upload
   everything in this folder to it (GitHub → *Add file → Upload files*, or
   `git push`). `api/config.php` is in `.gitignore` — never upload it.
2. MilesWeb panel → **FTP Accounts** → note the FTP server, username and
   password (create an FTP account if needed).
3. GitHub repo → **Settings → Secrets and variables → Actions → New
   repository secret**, add: `FTP_SERVER`, `FTP_USERNAME`, `FTP_PASSWORD`,
   `FTP_DIR` (`public_html/` — or `./` if that FTP account opens
   public_html directly).
4. GitHub repo → **Actions** tab → *Deploy to MilesWeb* → **Run workflow**.
   From now on every push to `main` uploads the changed files automatically.

Check in File Manager that `index.html`, `api/` and `.htaccess` are directly
inside `public_html` (turn on "Show hidden files" to see `.htaccess`).

*Alternative:* if your panel has **Git Version Control**, you can clone the
repo there instead and use the included `.cpanel.yml` (edit USERNAME first).

## 4. Fill in the config

In File Manager open `public_html/api/`, rename `config.sample.php` to
`config.php`, click **Edit**, and set:

| Setting | Value |
|---|---|
| `DB_HOST` | `localhost` |
| `DB_NAME`, `DB_USER`, `DB_PASSWORD` | from step 1 (with prefix) |
| `JWT_SECRET` | the **same** `JWT_SECRET` as in your Vercel project (Settings → Environment Variables) so everyone stays logged in |
| `APP_TIMEZONE` | `Asia/Kolkata` |

## 5. Check it (after step 6)

Open `https://yourdomain.com/api/health` — you should see
`"database":"connected","tablesCreated":true` and your user count.

Then open `https://yourdomain.com` — the landing page should load with your plans.

## 6. Import your database (.sql)

Do this **before** opening the website for the first time (the site creates
empty tables on its first visit, and the import would then fail with
"table already exists").

Panel → **phpMyAdmin** → click your database on the left → **Import** →
choose your `.sql` file (zip/gz it if it's big) → **Import**.
If it fails, note the error message.

If you already opened the site and the tables exist: in phpMyAdmin select
all tables → **Drop**, then import again.

## 7. Go live

- Control panel → **SSL / Let's Encrypt** → issue the free certificate for your domain.
- Sign in as coach and as a client and click around.
- Android app: point its WebView at `https://yourdomain.com/app-login.html`.
- When everything works, delete the Vercel project and the Aiven service.

## Troubleshooting

| Problem | Fix |
|---|---|
| Every page shows the landing page / `/api/health` shows the landing page | `.htaccess` missing or not in `public_html` — upload it again (show hidden files). |
| Login says "Missing authentication token" | Same — `.htaccess` must be present (it passes the login token to PHP). |
| `/api/health` says "database NOT connected" | Check the names/password in `api/config.php` (include the prefix) and that the user was added to the database with ALL PRIVILEGES. |
| Blank page / error 500 | PHP version below 8.1 — set PHP 8.2 (step 2). |
| Brochure PDF upload fails | Control panel → Select PHP Version → Options → raise `post_max_size` and `upload_max_filesize` to 20M. |
| Second coach account | phpMyAdmin → `users` table → change that row's `status` from `pending_approval` to `active`. |
