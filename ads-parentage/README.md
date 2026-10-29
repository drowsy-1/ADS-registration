# ADS Parentage Builder

A drop-in WordPress plugin for the American Daylily Society cultivar registration form (Gravity Forms form 15 at `/user-dashboard/register-cultivar/`). It replaces the one-pod / one-pollen inputs with a structured parentage builder that allows multi-generation lineage in the proper nested format, while keeping the registrar's existing data flow untouched.

```
(Heavenly Delight × sdlg)
((Stella de Oro × Heavenly Delight) × (Electric Snake × sdlg))
```

Only three things can ever appear as a leaf: a registered cultivar picked from the registry lookup, `sdlg`, or `unknown`. The multiplication sign is always `×` (U+00D7) with one space on each side, every `×` has exactly one pair of parentheses, and there are no spaces inside the parentheses. The string is never typed; it is rendered from the builder's tree and re-rendered and verified again on the server.

## Install (about five minutes)

1. Upload `ads-parentage.zip` under **Plugins → Add New → Upload Plugin** and activate it. Gravity Forms must be active.
2. On activation the plugin adds three fields to form 15, right after **Pollen Parent** (field 39). If it could not (for example GF was not active yet), an admin notice shows an **Add the fields now** button.
   - an HTML field *Parentage* with CSS class `ads-parentage-widget` (where the builder mounts)
   - a Hidden field *Parentage (full lineage)* with CSS class `ads-parentage-string`
   - a Hidden field *Parentage tree (JSON, do not edit)* with CSS class `ads-parentage-tree`
3. Open the registration page as a hybridizer. The four native fields (57, 58, 38, 39) are hidden and the builder sits where they were. Pick a pod and a pollen parent and watch the hidden lineage field fill in.

Nothing is removed or renamed. Deactivating the plugin restores the original form exactly; the three extra fields stay on the form but are inert (delete them in the form editor if you like).

## How it fits the existing pipeline

The registrar's backend only knows immediate parents. The builder keeps the native fields filled from the root of the tree, so everything downstream keeps working:

| Builder root side | Field 57 / 58 (options radio) | Field 38 / 39 (select) |
|---|---|---|
| Registered cultivar | `Choose Pod Parent` / `Choose Pollen Parent` | cultivar id (same value the native box posts) |
| `sdlg` | `sdlg` | cleared |
| `unknown` | `Unknown` | cleared |
| Known cross (nested) | `sdlg` (an unregistered seedling, per the Registration Guide) | cleared |

The full lineage goes into the hidden string field, and the tree into the hidden JSON field, so both are saved with drafts and entries. When no nesting is used, the lineage string is exactly `(Pod × Pollen)`, identical to what the backend composes today.

To use the lineage at approval or publication time:

```php
$lineage = ads_parentage_get_lineage( $entry );   // "((A × B) × sdlg)", or "(Pod × Pollen)" for old entries
$tree    = ads_parentage_get_tree( $entry );      // decoded array, or null
```

## Lookup

The builder reuses the same registry endpoint the native Pod Parent box uses (`gp_advanced_select_get_gppa_results`, GP Populate Anything), so results and ids are identical. It adds what the native box lacks:

- 350 ms debounce and abort of in-flight requests, so one typed name costs one or two calls instead of one per keystroke
- per-term cache, and prefix narrowing without a request once a result set is complete
- client-side ranking: exact match, then starts-with, then contains (the server sorts by id)
- `Load more` for result sets larger than one page, and a three-character minimum (configurable)

A name is committed only by picking it from the list, so typed text never reaches the form. If GP Populate Anything is ever removed from the page, the client falls back to the theme's `cultivar_autocomplete` action (names only); the server then verifies by name instead of id.

## Validation

Client side, submission is blocked (with the offending slot highlighted) while any slot is empty, any registered leaf lacks a registry id, depth exceeds the limit, or the rendered string fails the structure check. The guard covers the Submit button, the theme's *Submit for Approval* checkbox and the form's submit event. Save Draft is allowed with an incomplete tree by default (`block_draft_when_invalid`).

Server side, on the real submission (`gform_validation_15`), the plugin decodes the tree, re-renders the string with the same rules, and rejects the submission if:

- the tree is missing, has an empty slot, is nested deeper than `max_depth`, or any leaf is not registered / `sdlg` / `unknown`
- the submitted string differs from the re-rendered one
- fields 57, 58, 38, 39 disagree with the tree's root
- a registered leaf's id and name do not match the cultivar table (`wp_cultivar_search_data` by default; verification is skipped with a log line if the table is not found)

Gravity Forms does not validate Save-and-Continue drafts, which is why drafts may hold a half-built tree.

## Configuration

Everything is a filter. Example, in a small mu-plugin or the theme's functions file:

```php
add_filter( 'ads_parentage_settings', function ( $s ) {
    $s['max_depth']                = 3;      // generations allowed
    $s['lookup']['min_chars']      = 4;
    $s['block_draft_when_invalid'] = true;
    $s['lookup_table']             = 'cultivar_search_data'; // without the wp_ prefix
    return $s;
} );
```

Keys: `form_id`, `fields` (pod_mode, pollen_mode, pod, pollen), `mode_values`, `approval_checkbox_id`, `lookup` (strategy auto|gppa|theme, field_id, page_size, min_chars, debounce_ms), `max_depth`, `hide_native_fields`, `block_draft_when_invalid`, `require_ids`, `verify_in_db`, `lookup_table`, `lookup_id_column`, `lookup_name_column`, `labels` (override any UI text).

Two more filters: `ads_parentage_config` (the JavaScript config, per form) and `ads_parentage_validation_errors` (add or remove server-side errors).

## Staging checklist

1. Activate on staging, confirm the three fields appear after Pollen Parent in the form editor.
2. Load the registration page; the builder shows and the four native fields are hidden. Untick nothing else.
3. Pick a registered pod parent and `sdlg` pollen: Save Draft, reopen the draft, confirm the chip and the string survived.
4. Build a nested cross on one side, submit for approval, and check the entry: field 57/58 shows `sdlg`, the lineage field shows the nested string.
5. Confirm the id match once: in the database, `SELECT id, post_title FROM wp_cultivar_search_data WHERE id = <an id you picked>` should return the picked name. If the lookup table is named differently, set `lookup_table`.
6. Temporarily edit the hidden string in DevTools and submit: the server must reject it.

## Files

- `ads-parentage.php` – plugin header, constants, bootstrap
- `includes/class-ads-parentage-plugin.php` – field installation, enqueue, GF validation hooks, helper functions
- `includes/class-ads-parentage-validator.php` – server-side twin of the core rules
- `assets/parentage-core.js` – tree model, renderer, validator (no DOM)
- `assets/parentage-widget.js` – lookup client, builder UI, Gravity Forms adapter
- `assets/parentage-widget.css` – styles (inherits the Kadence palette)

## Assumptions to verify on the live site

- The `page` key for the second page of lookup results is inferred from GP Advanced Select; if `Load more` returns the same page, that key name differs.
- GP Advanced Select exposes its Tom Select instance as `select.tomselect` (current versions do); if not, the native select is set directly, which still submits correctly.
- The cultivar table name and columns (`wp_cultivar_search_data`, `id`, `post_title`) come from the SQL the public search echoes; adjust via settings if the registrar's source differs.
