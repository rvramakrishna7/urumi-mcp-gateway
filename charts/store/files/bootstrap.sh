#!/bin/sh
# Idempotent store bootstrap. Runs as a Helm post-install and post-upgrade hook.
# Every step first checks the current state, so running it again changes nothing that is already correct.
#
# Secret handling: the real admin password is read from a mounted file inside PHP and is never placed in a
# command line, a prompt or a log line. WordPress is installed with a random throwaway password that is
# replaced straight away. (WP-CLI --prompt echoes the value it reads, so it must not be used for secrets.)
set -eu

WP_PATH=/var/www/html
export ADMIN_PASSWORD_FILE=/secrets/wordpress-admin-password
ADMIN_PASSWORD_MARKER=store_bootstrap_admin_password_set

log() {
  printf '[bootstrap] %s\n' "$*"
}

wpcli() {
  wp --path="$WP_PATH" "$@"
}

# Update a WordPress option only when its value differs.
set_option() {
  current="$(wpcli option get "$1" 2>/dev/null || true)"
  if [ "$current" = "$2" ]; then
    log "option $1 already $2"
  else
    wpcli option update "$1" "$2" >/dev/null
    log "option $1 set to $2"
  fi
}

log "waiting for WordPress files"
until [ -f "$WP_PATH/wp-config.php" ]; do
  sleep 3
done

log "waiting for the database"
until php -r '$m = @new mysqli(getenv("WORDPRESS_DB_HOST"), getenv("WORDPRESS_DB_USER"), getenv("WORDPRESS_DB_PASSWORD"), getenv("WORDPRESS_DB_NAME")); exit($m->connect_errno ? 1 : 0);'; do
  sleep 3
done

if wpcli core is-installed; then
  log "WordPress core already installed"
else
  log "installing WordPress core with a throwaway admin password"
  throwaway_password="$(head -c 32 /dev/urandom | base64 | tr -d '\n=+/')"
  wpcli core install \
    --url="$SITE_URL" \
    --title="$SITE_TITLE" \
    --admin_user="$ADMIN_USER" \
    --admin_email="$ADMIN_EMAIL" \
    --admin_password="$throwaway_password" \
    --skip-email
  unset throwaway_password
fi

# The real password is applied once. Later runs leave it alone so a password changed in wp-admin is not reset.
# The option list is captured first so that a failing WP-CLI call stops the script (set -e) instead of being
# read as "marker missing", which would overwrite a password changed in wp-admin.
marker_options="$(wpcli option list --search="$ADMIN_PASSWORD_MARKER" --field=option_name)"
if ! printf '%s\n' "$marker_options" | grep -qx "$ADMIN_PASSWORD_MARKER"; then
  log "setting the admin password from the Secret"
  wpcli eval 'wp_set_password(trim(file_get_contents(getenv("ADMIN_PASSWORD_FILE"))), get_user_by("login", getenv("ADMIN_USER"))->ID);'
  password_check="$(wpcli eval '$u = get_user_by("login", getenv("ADMIN_USER")); echo wp_check_password(trim(file_get_contents(getenv("ADMIN_PASSWORD_FILE"))), $u->user_pass, $u->ID) ? "password-ok" : "MISMATCH";')"
  log "admin password check: $password_check"
  if [ "$password_check" != "password-ok" ]; then
    exit 1
  fi
  wpcli option add "$ADMIN_PASSWORD_MARKER" 1 >/dev/null
else
  log "admin password already applied"
fi

if wpcli plugin is-installed woocommerce; then
  installed_version="$(wpcli plugin get woocommerce --field=version)"
  if [ "$installed_version" = "$WOOCOMMERCE_VERSION" ]; then
    log "WooCommerce $installed_version already installed"
  else
    log "changing WooCommerce from $installed_version to $WOOCOMMERCE_VERSION"
    wpcli plugin install woocommerce --version="$WOOCOMMERCE_VERSION" --force
  fi
else
  log "installing WooCommerce $WOOCOMMERCE_VERSION"
  wpcli plugin install woocommerce --version="$WOOCOMMERCE_VERSION"
fi

if wpcli plugin is-active woocommerce; then
  log "WooCommerce already active"
else
  log "activating WooCommerce"
  wpcli plugin activate woocommerce
fi

# WooCommerce shows its Core Profiler wizard on the first admin visit. Finishing or skipping it calls
# POST /wc-admin/launch-your-store/initialize-coming-soon, which overwrites woocommerce_coming_soon with "yes".
# Marking the profile as skipped (the same state the Skip button writes) keeps the wizard from running.
# An existing profile is never overwritten, so a profile completed by hand stays completed.
if wpcli option get woocommerce_onboarding_profile >/dev/null 2>&1; then
  log "onboarding profile already present"
else
  wpcli option add woocommerce_onboarding_profile '{"skipped":true}' --format=json >/dev/null
  log "onboarding profile marked as skipped"
fi

log "configuring the store"
set_option woocommerce_allow_tracking no
set_option woocommerce_coming_soon no
set_option woocommerce_store_pages_only no
set_option woocommerce_currency "$STORE_CURRENCY"
set_option woocommerce_default_country "$STORE_COUNTRY"
set_option timezone_string "$STORE_TIMEZONE"

# Pretty permalinks are needed for /shop/ style URLs and for the WordPress REST API under /wp-json/.
if [ "$(wpcli option get permalink_structure 2>/dev/null || true)" = "/%postname%/" ]; then
  log "permalink structure already /%postname%/"
else
  wpcli rewrite structure '/%postname%/'
fi

# Cash on delivery is the test-friendly payment method.
wpcli wc payment_gateway update cod --enabled=true --user="$ADMIN_USER" >/dev/null
log "cash on delivery enabled"

# Zone 0 is the built-in "locations not covered by your other zones" zone, so free shipping applies everywhere.
# The list is captured first so that a failing WP-CLI call stops the script (set -e) instead of being read as
# "method missing", which would add a duplicate method.
zone_methods="$(wpcli wc shipping_zone_method list 0 --user="$ADMIN_USER" --field=method_id)"
if printf '%s\n' "$zone_methods" | grep -qx free_shipping; then
  log "free shipping already present in zone 0"
else
  wpcli wc shipping_zone_method create 0 --method_id=free_shipping --user="$ADMIN_USER" >/dev/null
  log "free shipping added to zone 0"
fi

# Read back everything the script configures. None of these values is a secret.
log "---- read back ----"
for option in woocommerce_coming_soon woocommerce_store_pages_only woocommerce_allow_tracking woocommerce_currency \
  woocommerce_default_country timezone_string permalink_structure woocommerce_custom_orders_table_enabled siteurl home; do
  log "option $option = $(wpcli option get "$option" 2>/dev/null || echo '<unset>')"
done
log "option woocommerce_onboarding_profile = $(wpcli option get woocommerce_onboarding_profile --format=json 2>/dev/null || echo '<unset>')"
log "payment gateway cod:"
wpcli wc payment_gateway get cod --fields=id,enabled,title --user="$ADMIN_USER"
log "shipping zone 0 methods:"
wpcli wc shipping_zone_method list 0 --fields=method_id,enabled --user="$ADMIN_USER"
log "users:"
wpcli user list --fields=ID,user_login,user_email,roles
log "plugins:"
wpcli plugin list --fields=name,status,version
log "done"
