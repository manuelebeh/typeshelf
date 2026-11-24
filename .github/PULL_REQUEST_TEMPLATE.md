## Why

## What changed

## Testing

- [ ] `npm run build`
- [ ] `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test` in `src-tauri`
- [ ] `npm run plugins:sync` run and the copies committed (if `plugins/shared` changed)
- [ ] Tried in the app, or in the plugin's application (say which version)
- [ ] The local API still refuses web pages and foreign hosts (if `plugin_api.rs` changed, see CONTRIBUTING.md › Safety rules)

Not tested:
