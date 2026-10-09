#!/bin/sh
# Read-only checks for the store, run by "helm test". Products and orders are listed through WP-CLI and WC-CLI,
# so the output is correct for either order storage mode. The storefront is checked through the WordPress Service.
# Nothing here changes data, and nothing prints secrets or customer details (no names, emails or addresses).
set -eu

WP_PATH=/var/www/html

log() {
  printf '[checks] %s\n' "$*"
}

wpcli() {
  wp --path="$WP_PATH" "$@"
}

log "versions"
log "wordpress $(wpcli core version), woocommerce $(wpcli plugin get woocommerce --field=version)"
log "timezone $(wpcli option get timezone_string), site time now $(wpcli eval 'echo current_time("Y-m-d H:i:s");')"
log "custom order tables option: $(wpcli option get woocommerce_custom_orders_table_enabled)"

log "products (WC-CLI):"
wpcli wc product list --user="$ADMIN_USER" --per_page=100 --fields=id,name,status,price,regular_price

log "orders (WC-CLI):"
wpcli wc shop_order list --user="$ADMIN_USER" --per_page=100 --fields=id,number,status,total,currency,payment_method,date_created

log "orders in total: $(wpcli eval 'echo count(wc_get_orders(array("limit" => -1, "return" => "ids")));')"
log "orders created today: $(wpcli eval '$tz = wp_timezone(); $start = (new DateTime("today", $tz))->getTimestamp(); $end = (new DateTime("tomorrow", $tz))->getTimestamp() - 1; echo count(wc_get_orders(array("limit" => -1, "return" => "ids", "date_created" => $start . "..." . $end)));')"

# The storefront must be live and every published product must appear on the shop page.
# The request goes to the Service with the public Host header, so it does not depend on DNS or the Ingress.
log "storefront:"
wpcli eval '
$ctx = stream_context_create(array("http" => array(
  "header" => "Host: " . getenv("STORE_HOST") . "\r\n",
  "ignore_errors" => true,
  "follow_location" => 0,
)));
$fetch = function ($url) use ($ctx) {
  $body = @file_get_contents($url, false, $ctx);
  $status = isset($http_response_header[0]) ? $http_response_header[0] : "no response";
  return array($status, (string) $body);
};
$failures = 0;
$check = function ($ok, $message) use (&$failures) {
  echo ($ok ? "ok:   " : "FAIL: ") . $message . "\n";
  if (!$ok) {
    $failures++;
  }
};
list($homeStatus, $homeBody) = $fetch("http://wordpress/");
list($shopStatus, $shopBody) = $fetch("http://wordpress/shop/");
$check(strpos($homeStatus, " 200") !== false, "home page status: " . $homeStatus);
$check(stripos($homeBody, "coming soon") === false, "home page does not say coming soon");
$check(strpos($shopStatus, " 200") !== false, "shop page status: " . $shopStatus);
$check(stripos($shopBody, "coming soon") === false, "shop page does not say coming soon");
$products = wc_get_products(array("status" => "publish", "limit" => -1));
echo "published products: " . count($products) . "\n";
foreach ($products as $product) {
  $check(strpos($shopBody, esc_html($product->get_name())) !== false, "product on shop page: " . $product->get_name());
}
exit($failures > 0 ? 1 : 0);
'

# The woo-mcp service account and its REST API key. Only names, counts and yes/no answers are printed.
# The key and the secret are read from the mounted Secret files inside PHP and compared with what WooCommerce stores.
log "woo-mcp account and API key:"
wpcli eval '
$failures = 0;
$check = function ($ok, $message) use (&$failures) {
  echo ($ok ? "ok:   " : "FAIL: ") . $message . "\n";
  if (!$ok) {
    $failures++;
  }
};
$login = getenv("WOO_MCP_USER");
$users = get_users(array("login" => $login));
$check(count($users) === 1, "users named " . $login . ": " . count($users));
if (count($users) === 1) {
  $user = $users[0];
  $check($user->roles === array("shop_manager"), "roles: " . implode(",", $user->roles));
  foreach (array("edit_products", "publish_products", "edit_shop_orders", "edit_others_shop_orders") as $cap) {
    $check(user_can($user, $cap), "can " . $cap);
  }
  foreach (array("manage_options", "install_plugins", "activate_plugins", "create_users", "delete_users", "promote_users") as $cap) {
    $check(!user_can($user, $cap), "cannot " . $cap);
  }
  // WooCommerce lets shop managers edit customer accounts, but not the administrator.
  $admin = get_user_by("login", getenv("ADMIN_USER"));
  $check($admin !== false, "administrator account found");
  if ($admin) {
    $check(!user_can($user, "edit_user", $admin->ID), "cannot edit the administrator account");
    $check(!user_can($user, "promote_user", $admin->ID), "cannot promote the administrator account");
    $check(!user_can($user, "delete_user", $admin->ID), "cannot delete the administrator account");
  }
  global $wpdb;
  $table = $wpdb->prefix . "woocommerce_api_keys";
  $rows = $wpdb->get_results($wpdb->prepare("SELECT user_id, permissions, consumer_key, consumer_secret FROM {$table} WHERE description = %s", "woo-mcp (managed by the store chart)"));
  $check(count($rows) === 1, "API keys with the managed description: " . count($rows));
  if (count($rows) === 1) {
    $key = trim(file_get_contents(getenv("WOO_MCP_KEY_FILE")));
    $secret = trim(file_get_contents(getenv("WOO_MCP_SECRET_FILE")));
    $check((int) $rows[0]->user_id === (int) $user->ID, "API key belongs to " . $login);
    $check($rows[0]->permissions === "read_write", "API key permissions: " . $rows[0]->permissions);
    $check(hash_equals($rows[0]->consumer_key, wc_api_hash($key)), "stored key matches the Secret");
    $check(hash_equals($rows[0]->consumer_secret, $secret), "stored secret matches the Secret");
  }
}
exit($failures > 0 ? 1 : 0);
'

log "all checks passed"
