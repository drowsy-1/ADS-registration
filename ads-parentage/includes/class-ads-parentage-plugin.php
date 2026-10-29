<?php
/**
 * Wires the builder into Gravity Forms: installs the three support fields,
 * enqueues the widget on the registration form, validates on submit.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class ADS_Parentage_Plugin {

	const CLASS_WIDGET = 'ads-parentage-widget';
	const CLASS_STRING = 'ads-parentage-string';
	const CLASS_TREE   = 'ads-parentage-tree';
	const NONCE_ACTION = 'ads_parentage_install_fields';

	/** @var ADS_Parentage_Plugin|null */
	private static $instance = null;

	/** @var string */
	private $error_message = '';

	public static function instance() {
		if ( self::$instance === null ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * All knobs live here. Override with:
	 *   add_filter( 'ads_parentage_settings', function ( $s ) { $s['max_depth'] = 3; return $s; } );
	 */
	public static function settings() {
		$defaults = array(
			'form_id'              => 15,
			'fields'               => array( 'pod_mode' => 57, 'pollen_mode' => 58, 'pod' => 38, 'pollen' => 39 ),
			'mode_values'          => array(
				'pod'    => array( 'choose' => 'Choose Pod Parent', 'unknown' => 'Unknown', 'sdlg' => 'sdlg' ),
				'pollen' => array( 'choose' => 'Choose Pollen Parent', 'unknown' => 'Unknown', 'sdlg' => 'sdlg' ),
			),
			'approval_checkbox_id' => 'choice_15_43_1',
			'lookup'               => array( 'strategy' => 'auto', 'field_id' => 38, 'page_size' => 50, 'min_chars' => 3, 'debounce_ms' => 350 ),
			'max_depth'            => 4,
			'hide_native_fields'   => true,
			'block_draft_when_invalid' => false,
			'require_ids'          => false,  // server side: verify by id when present, else by name
			'verify_in_db'         => true,
			'lookup_table'         => 'cultivar_search_data', // prefixed with $wpdb->prefix
			'lookup_id_column'     => 'id',
			'lookup_name_column'   => 'post_title',
			'labels'               => array(),
		);
		return apply_filters( 'ads_parentage_settings', $defaults );
	}

	private function __construct() {
		$s       = self::settings();
		$form_id = (int) $s['form_id'];

		add_action( "gform_enqueue_scripts_{$form_id}", array( $this, 'enqueue' ), 10, 2 );
		add_filter( "gform_pre_render_{$form_id}", array( $this, 'ensure_mount_markup' ) );
		add_filter( "gform_validation_{$form_id}", array( $this, 'validate_submission' ) );
		add_filter( 'gform_validation_message', array( $this, 'validation_message' ), 10, 2 );
		add_action( 'admin_notices', array( $this, 'admin_notice' ) );
		add_action( 'admin_post_' . self::NONCE_ACTION, array( $this, 'handle_install_request' ) );
	}

	/* ------------------------------------------------------------------ */
	/* Activation / field installation                                      */
	/* ------------------------------------------------------------------ */

	public static function activate() {
		if ( ! class_exists( 'GFAPI' ) ) {
			return; // notice will explain
		}
		$result = self::install_fields();
		if ( is_wp_error( $result ) ) {
			update_option( 'ads_parentage_install_error', $result->get_error_message(), false );
		} else {
			delete_option( 'ads_parentage_install_error' );
		}
	}

	/** Find our three fields on the form by CSS class. */
	public static function find_fields( $form ) {
		$found = array( 'widget' => null, 'string' => null, 'tree' => null );
		if ( empty( $form['fields'] ) ) {
			return $found;
		}
		foreach ( $form['fields'] as $field ) {
			$css = ' ' . ( is_object( $field ) ? (string) $field->cssClass : (string) rgar( $field, 'cssClass' ) ) . ' ';
			$id  = (int) ( is_object( $field ) ? $field->id : rgar( $field, 'id' ) );
			if ( strpos( $css, ' ' . self::CLASS_WIDGET . ' ' ) !== false ) { $found['widget'] = $id; }
			if ( strpos( $css, ' ' . self::CLASS_STRING . ' ' ) !== false ) { $found['string'] = $id; }
			if ( strpos( $css, ' ' . self::CLASS_TREE . ' ' ) !== false ) { $found['tree'] = $id; }
		}
		return $found;
	}

	/**
	 * Add the HTML mount field and the two hidden fields right after the
	 * Pollen Parent field. Idempotent. Never removes or edits existing fields.
	 */
	public static function install_fields() {
		if ( ! class_exists( 'GFAPI' ) ) {
			return new WP_Error( 'no_gf', 'Gravity Forms is not active.' );
		}
		$s       = self::settings();
		$form_id = (int) $s['form_id'];
		$form    = GFAPI::get_form( $form_id );
		if ( ! $form ) {
			return new WP_Error( 'no_form', sprintf( 'Gravity Form #%d was not found.', $form_id ) );
		}
		$have = self::find_fields( $form );
		if ( $have['widget'] && $have['string'] && $have['tree'] ) {
			return true;
		}
		$next   = GFFormsModel::get_next_field_id( $form['fields'] );
		$anchor = count( $form['fields'] ) - 1;
		foreach ( $form['fields'] as $i => $field ) {
			if ( (int) $field->id === (int) $s['fields']['pollen'] ) {
				$anchor = $i;
				break;
			}
		}
		$new = array();
		if ( ! $have['widget'] ) {
			$new[] = GF_Fields::create( array(
				'type'           => 'html',
				'id'             => $next++,
				'formId'         => $form_id,
				'label'          => 'Parentage',
				'cssClass'       => self::CLASS_WIDGET,
				'content'        => '<div class="ads-parentage-mount"></div>',
				'disableMargins' => false,
			) );
		}
		if ( ! $have['string'] ) {
			$new[] = GF_Fields::create( array(
				'type'     => 'hidden',
				'id'       => $next++,
				'formId'   => $form_id,
				'label'    => 'Parentage (full lineage)',
				'cssClass' => self::CLASS_STRING,
			) );
		}
		if ( ! $have['tree'] ) {
			$new[] = GF_Fields::create( array(
				'type'     => 'hidden',
				'id'       => $next++,
				'formId'   => $form_id,
				'label'    => 'Parentage tree (JSON, do not edit)',
				'cssClass' => self::CLASS_TREE,
			) );
		}
		array_splice( $form['fields'], $anchor + 1, 0, $new );
		$result = GFAPI::update_form( $form );
		return is_wp_error( $result ) ? $result : true;
	}

	public function handle_install_request() {
		if ( ! current_user_can( 'manage_options' ) && ! current_user_can( 'gravityforms_edit_forms' ) ) {
			wp_die( 'Not allowed.' );
		}
		check_admin_referer( self::NONCE_ACTION );
		$result = self::install_fields();
		if ( is_wp_error( $result ) ) {
			update_option( 'ads_parentage_install_error', $result->get_error_message(), false );
		} else {
			delete_option( 'ads_parentage_install_error' );
		}
		wp_safe_redirect( wp_get_referer() ? wp_get_referer() : admin_url( 'plugins.php' ) );
		exit;
	}

	public function admin_notice() {
		if ( ! current_user_can( 'manage_options' ) && ! current_user_can( 'gravityforms_edit_forms' ) ) {
			return;
		}
		if ( ! class_exists( 'GFAPI' ) ) {
			echo '<div class="notice notice-error"><p><strong>ADS Parentage Builder</strong> needs Gravity Forms to be active.</p></div>';
			return;
		}
		$s    = self::settings();
		$form = GFAPI::get_form( (int) $s['form_id'] );
		$have = $form ? self::find_fields( $form ) : array( 'widget' => null, 'string' => null, 'tree' => null );
		$err  = get_option( 'ads_parentage_install_error' );
		if ( $form && $have['widget'] && $have['string'] && $have['tree'] && ! $err ) {
			return;
		}
		$url = wp_nonce_url( admin_url( 'admin-post.php?action=' . self::NONCE_ACTION ), self::NONCE_ACTION );
		echo '<div class="notice notice-warning"><p><strong>ADS Parentage Builder:</strong> the support fields are not yet on form #' . (int) $s['form_id'] . '.';
		if ( $err ) {
			echo ' Last attempt failed: ' . esc_html( $err ) . '.';
		}
		echo ' <a class="button button-primary" href="' . esc_url( $url ) . '">Add the fields now</a></p></div>';
	}

	/* ------------------------------------------------------------------ */
	/* Front end                                                            */
	/* ------------------------------------------------------------------ */

	public function ensure_mount_markup( $form ) {
		$have = self::find_fields( $form );
		if ( $have['widget'] ) {
			foreach ( $form['fields'] as $field ) {
				if ( (int) $field->id === $have['widget'] && trim( (string) $field->content ) === '' ) {
					$field->content = '<div class="ads-parentage-mount"></div>';
				}
			}
		}
		return $form;
	}

	public function enqueue( $form, $is_ajax ) {
		$s    = self::settings();
		$have = self::find_fields( $form );
		$ver  = ADS_PARENTAGE_VERSION;

		wp_register_script( 'ads-parentage-core', ADS_PARENTAGE_URL . 'assets/parentage-core.js', array(), $ver, true );
		wp_register_script( 'ads-parentage-widget', ADS_PARENTAGE_URL . 'assets/parentage-widget.js', array( 'ads-parentage-core', 'jquery' ), $ver, true );
		wp_register_style( 'ads-parentage-widget', ADS_PARENTAGE_URL . 'assets/parentage-widget.css', array(), $ver );

		$config = array(
			'formId'              => (int) $s['form_id'],
			'fields'              => array(
				'podMode'    => (int) $s['fields']['pod_mode'],
				'pollenMode' => (int) $s['fields']['pollen_mode'],
				'pod'        => (int) $s['fields']['pod'],
				'pollen'     => (int) $s['fields']['pollen'],
				'widget'     => $have['widget'],
				'string'     => $have['string'],
				'tree'       => $have['tree'],
			),
			'modeValues'          => $s['mode_values'],
			'approvalCheckboxId'  => $s['approval_checkbox_id'],
			'lookup'              => array(
				'strategy'   => $s['lookup']['strategy'],
				'fieldId'    => (int) $s['lookup']['field_id'],
				'pageSize'   => (int) $s['lookup']['page_size'],
				'minChars'   => (int) $s['lookup']['min_chars'],
				'debounceMs' => (int) $s['lookup']['debounce_ms'],
				'ajaxUrl'    => admin_url( 'admin-ajax.php' ),
			),
			'maxDepth'            => (int) $s['max_depth'],
			'hideNativeFields'    => (bool) $s['hide_native_fields'],
			'blockDraftWhenInvalid' => (bool) $s['block_draft_when_invalid'],
			'requireIds'          => null,
			'labels'              => (array) $s['labels'],
		);
		$config = apply_filters( 'ads_parentage_config', $config, $form );

		wp_localize_script( 'ads-parentage-widget', 'adsParentageConfig', $config );
		wp_enqueue_style( 'ads-parentage-widget' );
		wp_enqueue_script( 'ads-parentage-widget' );
	}

	/* ------------------------------------------------------------------ */
	/* Validation                                                           */
	/* ------------------------------------------------------------------ */

	public function validate_submission( $validation_result ) {
		$form = $validation_result['form'];
		$s    = self::settings();
		$have = self::find_fields( $form );
		if ( ! $have['string'] || ! $have['tree'] ) {
			return $validation_result; // support fields not installed: do nothing
		}
		$f      = $s['fields'];
		$native = array(
			'pod_mode'    => rgpost( 'input_' . $f['pod_mode'] ),
			'pollen_mode' => rgpost( 'input_' . $f['pollen_mode'] ),
			'pod'         => rgpost( 'input_' . $f['pod'] ),
			'pollen'      => rgpost( 'input_' . $f['pollen'] ),
		);
		$validator = new ADS_Parentage_Validator( $s );
		$check     = $validator->check_submission( rgpost( 'input_' . $have['tree'] ), rgpost( 'input_' . $have['string'] ), $native );
		if ( $check['ok'] ) {
			return $validation_result;
		}
		$this->error_message = implode( ' ', $check['errors'] );
		$validation_result['is_valid'] = false;
		foreach ( $form['fields'] as $field ) {
			if ( (int) $field->id === (int) $have['string'] ) {
				$field->failed_validation  = true;
				$field->validation_message = $this->error_message;
			}
		}
		$validation_result['form'] = $form;
		return $validation_result;
	}

	public function validation_message( $message, $form ) {
		$s = self::settings();
		if ( (int) rgar( $form, 'id' ) !== (int) $s['form_id'] || $this->error_message === '' ) {
			return $message;
		}
		return $message . '<div class="gform_validation_errors ads-parentage-error" role="alert"><h2 class="gform_submission_error hide_summary">Parentage: ' . esc_html( $this->error_message ) . '</h2></div>';
	}
}

/* ---------------------------------------------------------------------- */
/* Helpers for the ADS team's own code (approval / publication step)       */
/* ---------------------------------------------------------------------- */

/**
 * Canonical full-lineage string for an entry, e.g. "((A × B) × sdlg)".
 * Falls back to "(pod × pollen)" built from the native fields when the
 * builder string is empty, so it is safe to use for every entry.
 */
function ads_parentage_get_lineage( $entry, $form = null ) {
	if ( ! $form && class_exists( 'GFAPI' ) ) {
		$form = GFAPI::get_form( rgar( $entry, 'form_id' ) );
	}
	$s    = ADS_Parentage_Plugin::settings();
	$have = $form ? ADS_Parentage_Plugin::find_fields( $form ) : array( 'string' => null, 'tree' => null );
	$str  = $have['string'] ? trim( (string) rgar( $entry, (string) $have['string'] ) ) : '';
	if ( $str !== '' ) {
		return apply_filters( 'ads_parentage_lineage', $str, $entry, $form );
	}
	// Fallback: immediate parents only.
	$side = function ( $mode_field, $select_field, $mv ) use ( $entry, $form ) {
		$mode = (string) rgar( $entry, (string) $mode_field );
		if ( $mode === $mv['unknown'] ) { return 'unknown'; }
		if ( $mode === $mv['sdlg'] ) { return 'sdlg'; }
		$id = (string) rgar( $entry, (string) $select_field );
		if ( $form ) {
			foreach ( $form['fields'] as $field ) {
				if ( (int) $field->id === (int) $select_field && ! empty( $field->choices ) ) {
					foreach ( $field->choices as $choice ) {
						if ( (string) $choice['value'] === $id ) { return (string) $choice['text']; }
					}
				}
			}
		}
		return $id;
	};
	$pod    = $side( $s['fields']['pod_mode'], $s['fields']['pod'], $s['mode_values']['pod'] );
	$pollen = $side( $s['fields']['pollen_mode'], $s['fields']['pollen'], $s['mode_values']['pollen'] );
	return apply_filters( 'ads_parentage_lineage', '(' . $pod . ' ' . ADS_Parentage_Validator::TIMES . ' ' . $pollen . ')', $entry, $form );
}

/** Decoded tree for an entry, or null. */
function ads_parentage_get_tree( $entry, $form = null ) {
	if ( ! $form && class_exists( 'GFAPI' ) ) {
		$form = GFAPI::get_form( rgar( $entry, 'form_id' ) );
	}
	$have = $form ? ADS_Parentage_Plugin::find_fields( $form ) : array( 'tree' => null );
	if ( ! $have['tree'] ) {
		return null;
	}
	$tree = json_decode( (string) rgar( $entry, (string) $have['tree'] ), true );
	return is_array( $tree ) ? $tree : null;
}
