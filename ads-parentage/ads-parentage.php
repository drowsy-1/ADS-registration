<?php
/**
 * Plugin Name: ADS Parentage Builder
 * Plugin URI:  https://daylilies.org/
 * Description: Replaces the one-pod / one-pollen parent inputs on the cultivar registration form with a structured, validated multi-generation parentage builder. Keeps the native fields in sync for the registrar, records the full lineage as a canonical "(Pod × Pollen)" string, and re-verifies every registered name on the server.
 * Version:     1.0.0
 * Requires at least: 6.0
 * Requires PHP: 7.4
 * Author:      ADS registration volunteers
 * License:     GPL-2.0-or-later
 * Text Domain: ads-parentage
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'ADS_PARENTAGE_VERSION', '1.0.0' );
define( 'ADS_PARENTAGE_FILE', __FILE__ );
define( 'ADS_PARENTAGE_DIR', plugin_dir_path( __FILE__ ) );
define( 'ADS_PARENTAGE_URL', plugin_dir_url( __FILE__ ) );

require_once ADS_PARENTAGE_DIR . 'includes/class-ads-parentage-validator.php';
require_once ADS_PARENTAGE_DIR . 'includes/class-ads-parentage-plugin.php';

register_activation_hook( __FILE__, array( 'ADS_Parentage_Plugin', 'activate' ) );
add_action( 'plugins_loaded', array( 'ADS_Parentage_Plugin', 'instance' ) );
