<?php
/* Copy this file to config.php and fill in your values.
   Control panel -> MySQL Databases shows the database name and user
   (with prefix). Host is usually "localhost" on shared hosting. */
return [
    'DB_HOST'      => 'localhost',
    'DB_PORT'      => '3306',
    'DB_NAME'      => 'u123456789_fastcoach',
    'DB_USER'      => 'u123456789_fastcoach',
    'DB_PASSWORD'  => 'your-database-password',

    // Long random string. If you are moving from the old Node/Vercel site,
    // use the SAME JWT_SECRET so everyone stays logged in.
    'JWT_SECRET'   => 'change-me-to-a-long-random-string',

    // Calendar days (programme day, due dates) roll over at midnight here.
    'APP_TIMEZONE' => 'Asia/Kolkata',

    // Only for a remote database that needs SSL (e.g. Aiven). Leave as
    // 'false' for your hosting's own MySQL.
    'DB_SSL'       => 'false',
    'DB_SSL_CA'    => '',
];
