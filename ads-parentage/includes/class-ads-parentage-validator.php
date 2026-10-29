<?php
/**
 * Server-side twin of assets/parentage-core.js.
 * Re-renders the canonical string from the submitted tree, checks structure,
 * depth, leaf set, agreement with the native pod/pollen fields, and verifies
 * each registered name against the cultivar table.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class ADS_Parentage_Validator {

	const TIMES = "\u{00D7}"; // × U+00D7

	/** @var array */
	private $settings;

	/** @var bool|null */
	private $table_exists = null;

	public function __construct( array $settings ) {
		$this->settings = $settings;
	}

	/* ------------------------------------------------------------------ */
	/* Pure helpers                                                         */
	/* ------------------------------------------------------------------ */

	public static function node_type( $node ) {
		return ( is_array( $node ) && isset( $node['type'] ) ) ? (string) $node['type'] : '';
	}

	public static function render( $node ) {
		switch ( self::node_type( $node ) ) {
			case 'cross':
				return '(' . self::render( isset( $node['pod'] ) ? $node['pod'] : null ) . ' ' . self::TIMES . ' ' . self::render( isset( $node['pollen'] ) ? $node['pollen'] : null ) . ')';
			case 'registered':
				return isset( $node['name'] ) ? (string) $node['name'] : '';
			case 'sdlg':
				return 'sdlg';
			case 'unknown':
				return 'unknown';
			default:
				return '';
		}
	}

	public static function depth( $node ) {
		if ( self::node_type( $node ) !== 'cross' ) {
			return 0;
		}
		return 1 + max( self::depth( isset( $node['pod'] ) ? $node['pod'] : null ), self::depth( isset( $node['pollen'] ) ? $node['pollen'] : null ) );
	}

	public static function walk( $node, callable $fn, array $path = array() ) {
		$fn( $node, $path );
		if ( self::node_type( $node ) === 'cross' ) {
			self::walk( isset( $node['pod'] ) ? $node['pod'] : null, $fn, array_merge( $path, array( 'pod' ) ) );
			self::walk( isset( $node['pollen'] ) ? $node['pollen'] : null, $fn, array_merge( $path, array( 'pollen' ) ) );
		}
	}

	public static function path_label( array $path ) {
		if ( empty( $path ) ) {
			return 'Parentage';
		}
		$side = end( $path ) === 'pod' ? 'Pod parent' : 'Pollen parent';
		if ( count( $path ) === 1 ) {
			return $side;
		}
		$where = array_map( function ( $p ) { return $p === 'pod' ? 'pod side' : 'pollen side'; }, array_slice( $path, 0, -1 ) );
		return $side . ' (' . implode( ' › ', $where ) . ')';
	}

	public static function leaf_names( $tree ) {
		$out = array();
		self::walk( $tree, function ( $n ) use ( &$out ) {
			if ( self::node_type( $n ) === 'registered' && ! empty( $n['name'] ) ) {
				$out[] = (string) $n['name'];
			}
		} );
		return $out;
	}

	/** Same reduction as the JS: names -> N, then collapse "(X × Y)" to C until stable. */
	public static function is_well_formed( $string, array $names ) {
		if ( ! is_string( $string ) || $string === '' ) {
			return false;
		}
		usort( $names, function ( $a, $b ) { return strlen( $b ) - strlen( $a ); } );
		$s = $string;
		foreach ( $names as $name ) {
			if ( $name !== '' ) {
				$s = str_replace( $name, 'N', $s );
			}
		}
		$re = '/\((N|sdlg|unknown|C) ' . preg_quote( self::TIMES, '/' ) . ' (N|sdlg|unknown|C)\)/u';
		do {
			$prev = $s;
			$s    = preg_replace( $re, 'C', $s );
		} while ( $s !== null && $s !== $prev );
		return $s === 'C';
	}

	/** Mirror of Core.rootToNative(): how the root maps onto the native fields. */
	public static function root_to_native( array $tree ) {
		$side = function ( $n ) {
			switch ( self::node_type( $n ) ) {
				case 'registered':
					return array( 'mode' => 'choose', 'id' => isset( $n['id'] ) ? (string) $n['id'] : '', 'name' => isset( $n['name'] ) ? (string) $n['name'] : '' );
				case 'unknown':
					return array( 'mode' => 'unknown' );
				case 'sdlg':
				case 'cross':
					return array( 'mode' => 'sdlg' );
				default:
					return array( 'mode' => 'empty' );
			}
		};
		return array( 'pod' => $side( isset( $tree['pod'] ) ? $tree['pod'] : null ), 'pollen' => $side( isset( $tree['pollen'] ) ? $tree['pollen'] : null ) );
	}

	/* ------------------------------------------------------------------ */
	/* Validation                                                           */
	/* ------------------------------------------------------------------ */

	/**
	 * @return array{ok:bool,errors:string[],string:string}
	 */
	public function validate_tree( $tree ) {
		$errors      = array();
		$max_depth   = isset( $this->settings['max_depth'] ) ? (int) $this->settings['max_depth'] : 4;
		$require_ids = ! empty( $this->settings['require_ids'] );

		if ( self::node_type( $tree ) !== 'cross' ) {
			return array( 'ok' => false, 'errors' => array( 'Parentage must be a single cross: pod parent ' . self::TIMES . ' pollen parent.' ), 'string' => '' );
		}

		self::walk( $tree, function ( $n, $path ) use ( &$errors, $require_ids ) {
			$label = self::path_label( $path );
			$type  = self::node_type( $n );
			if ( ! in_array( $type, array( 'cross', 'registered', 'sdlg', 'unknown', 'empty' ), true ) ) {
				$errors[] = $label . ': unrecognised entry.';
				return;
			}
			if ( $type === 'empty' ) {
				$errors[] = $label . ' has not been chosen.';
			}
			if ( $type === 'registered' ) {
				$name = isset( $n['name'] ) ? (string) $n['name'] : '';
				if ( $name === '' ) {
					$errors[] = $label . ' has no cultivar name.';
				} elseif ( $name !== trim( $name ) || preg_match( '/\s{2,}/', $name ) ) {
					$errors[] = $label . ': name has stray spaces.';
				} elseif ( preg_match( '/[()' . preg_quote( self::TIMES, '/' ) . ']/u', $name ) ) {
					$errors[] = $label . ': name may not contain parentheses or ' . self::TIMES . '.';
				}
				if ( $require_ids && empty( $n['id'] ) ) {
					$errors[] = $label . ' must be picked from the registered-name list.';
				}
			}
		} );

		$depth = self::depth( $tree );
		if ( $depth > $max_depth ) {
			$errors[] = sprintf( 'Parentage is nested %d generations deep; the limit is %d.', $depth, $max_depth );
		}
		$string = empty( $errors ) ? self::render( $tree ) : '';
		if ( empty( $errors ) && ! self::is_well_formed( $string, self::leaf_names( $tree ) ) ) {
			$errors[] = 'Generated parentage string failed the structure check.';
		}
		return array( 'ok' => empty( $errors ), 'errors' => $errors, 'string' => $string );
	}

	/**
	 * Full check of a submission.
	 *
	 * @param string $tree_json        JSON from the hidden tree field.
	 * @param string $submitted_string Value of the hidden string field.
	 * @param array  $native           pod_mode, pollen_mode, pod, pollen as posted.
	 * @return array{ok:bool,errors:string[],string:string,tree:?array}
	 */
	public function check_submission( $tree_json, $submitted_string, array $native ) {
		$tree = json_decode( (string) $tree_json, true );
		if ( ! is_array( $tree ) ) {
			return array( 'ok' => false, 'errors' => array( 'Parentage is required: choose a pod parent and a pollen parent in the parentage builder.' ), 'string' => '', 'tree' => null );
		}
		$v = $this->validate_tree( $tree );
		if ( ! $v['ok'] ) {
			$v['tree'] = $tree;
			return $v;
		}
		$errors = array();

		if ( (string) $submitted_string !== $v['string'] ) {
			$errors[] = 'The recorded parentage string does not match the selections. Please re-open the parentage builder and submit again.';
		}

		$mv  = $this->settings['mode_values'];
		$nat = self::root_to_native( $tree );
		foreach ( array( 'pod', 'pollen' ) as $side ) {
			$posted_mode = isset( $native[ $side . '_mode' ] ) ? (string) $native[ $side . '_mode' ] : '';
			$posted_id   = isset( $native[ $side ] ) ? (string) $native[ $side ] : '';
			$mode        = $nat[ $side ]['mode'];
			$expected    = $mode === 'choose' ? $mv[ $side ]['choose'] : ( $mode === 'unknown' ? $mv[ $side ]['unknown'] : $mv[ $side ]['sdlg'] );
			if ( $posted_mode !== $expected ) {
				$errors[] = sprintf( 'The %s parent option ("%s") does not match the parentage builder ("%s").', $side, $posted_mode === '' ? 'blank' : $posted_mode, $expected );
			}
			if ( $mode === 'choose' && $nat[ $side ]['id'] !== '' && $posted_id !== $nat[ $side ]['id'] ) {
				$errors[] = sprintf( 'The %s parent selection does not match the parentage builder.', $side );
			}
		}

		if ( ! empty( $this->settings['verify_in_db'] ) ) {
			$self = $this;
			self::walk( $tree, function ( $n, $path ) use ( &$errors, $self ) {
				if ( self::node_type( $n ) !== 'registered' ) {
					return;
				}
				$ok = $self->verify_leaf( isset( $n['id'] ) ? $n['id'] : null, isset( $n['name'] ) ? $n['name'] : '' );
				if ( $ok === false ) {
					$errors[] = self::path_label( $path ) . ': "' . $n['name'] . '" is not a registered cultivar in the database.';
				}
			} );
		}

		if ( function_exists( 'apply_filters' ) ) {
			$errors = apply_filters( 'ads_parentage_validation_errors', $errors, $tree, $v['string'], $native );
		}
		return array( 'ok' => empty( $errors ), 'errors' => $errors, 'string' => $v['string'], 'tree' => $tree );
	}

	/**
	 * Verify one registered leaf against the cultivar table.
	 *
	 * @return bool|null true/false, or null when the table is unavailable (verification skipped).
	 */
	public function verify_leaf( $id, $name ) {
		global $wpdb;
		if ( ! isset( $wpdb ) ) {
			return null;
		}
		$clean = function ( $v ) { return preg_replace( '/[^A-Za-z0-9_]/', '', (string) $v ); };
		$table = $wpdb->prefix . $clean( $this->settings['lookup_table'] );
		$idc   = $clean( $this->settings['lookup_id_column'] );
		$namec = $clean( $this->settings['lookup_name_column'] );

		if ( $this->table_exists === null ) {
			$this->table_exists = (bool) $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $table ) );
			if ( ! $this->table_exists ) {
				error_log( '[ads-parentage] lookup table ' . $table . ' not found; DB verification skipped' );
			}
		}
		if ( ! $this->table_exists ) {
			return null;
		}
		$name = trim( (string) $name );
		if ( $id !== null && $id !== '' ) {
			$db_name = $wpdb->get_var( $wpdb->prepare( "SELECT `{$namec}` FROM `{$table}` WHERE `{$idc}` = %d LIMIT 1", (int) $id ) );
			if ( $db_name === null ) {
				return false;
			}
			return strcasecmp( trim( (string) $db_name ), $name ) === 0;
		}
		$count = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM `{$table}` WHERE `{$namec}` = %s", $name ) );
		return $count > 0;
	}
}
