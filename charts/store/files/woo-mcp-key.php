<?php
// Installs the WooCommerce REST API key of the woo-mcp user from the mounted Secret files. Run with "wp eval-file".
// Idempotent: the key row is identified by its description, so a repeat run never creates a second key.
// The key and the secret are read from files inside PHP. They are never placed in a command line, and this script
// prints only the outcome and the names of changed fields, never a value. Database errors are not printed either,
// because a MySQL error message can contain the value that was being written.

$fail = function ($message) {
	fwrite(STDERR, '[woo-mcp-key] FAIL: ' . $message . "\n");
	exit(1);
};

$read = function ($env_name) use ($fail) {
	$path = getenv($env_name);
	if (!$path || !is_readable($path)) {
		$fail($env_name . ' does not point to a readable file');
	}
	return trim(file_get_contents($path));
};

$consumer_key    = $read('WOO_MCP_KEY_FILE');
$consumer_secret = $read('WOO_MCP_SECRET_FILE');
if (!preg_match('/^ck_[a-f0-9]{40}$/', $consumer_key)) {
	$fail('the consumer key does not have the expected format');
}
if (!preg_match('/^cs_[a-f0-9]{40}$/', $consumer_secret)) {
	$fail('the consumer secret does not have the expected format');
}

$user = get_user_by('login', (string) getenv('WOO_MCP_USER'));
if (!$user) {
	$fail('the woo-mcp user does not exist');
}

global $wpdb;
$wpdb->hide_errors();
$wpdb->suppress_errors(true);

$table       = $wpdb->prefix . 'woocommerce_api_keys';
$description = 'woo-mcp (managed by the store chart)';
$permissions = 'read_write';
$hash        = wc_api_hash($consumer_key);

$clashes = (int) $wpdb->get_var($wpdb->prepare(
	"SELECT COUNT(*) FROM {$table} WHERE consumer_key = %s AND (description IS NULL OR description <> %s)",
	$hash,
	$description
));
if ($clashes > 0) {
	$fail('another API key already uses this consumer key');
}

$rows = $wpdb->get_results($wpdb->prepare(
	"SELECT key_id, user_id, permissions, consumer_key, consumer_secret FROM {$table} WHERE description = %s",
	$description
));
if (count($rows) > 1) {
	$fail('more than one API key carries the managed description (' . count($rows) . ')');
}

$data = array(
	'user_id'         => $user->ID,
	'permissions'     => $permissions,
	'consumer_key'    => $hash,
	'consumer_secret' => $consumer_secret,
	'truncated_key'   => substr($consumer_key, -7),
);

if (count($rows) === 0) {
	$inserted = $wpdb->insert($table, array_merge(array('description' => $description), $data), array('%s', '%d', '%s', '%s', '%s', '%s'));
	if ($inserted !== 1) {
		$fail('inserting the API key failed');
	}
	echo "api key created\n";
	return;
}

$row     = $rows[0];
$changed = array();
if ((int) $row->user_id !== (int) $user->ID) {
	$changed[] = 'user';
}
if ($row->permissions !== $permissions) {
	$changed[] = 'permissions';
}
if (!hash_equals((string) $row->consumer_key, $hash)) {
	$changed[] = 'key';
}
if (!hash_equals((string) $row->consumer_secret, $consumer_secret)) {
	$changed[] = 'secret';
}

if (count($changed) === 0) {
	echo "api key unchanged\n";
	return;
}

$updated = $wpdb->update($table, $data, array('key_id' => (int) $row->key_id), array('%d', '%s', '%s', '%s', '%s'), array('%d'));
if ($updated === false) {
	$fail('updating the API key failed');
}
echo 'api key updated: ' . implode(',', $changed) . "\n";
