//! Where a library lives, as far as its path tells. Typeshelf does not talk to any sync
//! service: it only knows that something else may be carrying the folder to other computers.

use std::path::Path;

/// The service or kind of drive that shares the folder, or `None` for a plain local folder.
/// Services are named; any other external or network drive is `"drive"`.
pub fn shared_by(root: &Path) -> Option<&'static str> {
    let text = root.to_string_lossy().replace('\\', "/").to_lowercase();
    let parts: Vec<&str> = text.split('/').collect();
    // The last part is the library itself, whatever it is called.
    let folders = &parts[..parts.len().saturating_sub(1)];
    for (i, part) in folders.iter().enumerate() {
        let in_cloud_storage = i > 0 && folders[i - 1] == "cloudstorage";
        let service = match *part {
            "mobile documents" | "icloud drive" | "iclouddrive" => "iCloud Drive",
            "dropbox" => "Dropbox",
            p if p.starts_with("dropbox (") || (in_cloud_storage && p.starts_with("dropbox")) => "Dropbox",
            "google drive" | "my drive" | "shared drives" => "Google Drive",
            p if p.starts_with("googledrive-") => "Google Drive",
            p if p == "onedrive" || p.starts_with("onedrive -") || p.starts_with("onedrive-") => "OneDrive",
            "box sync" | "box-box" => "Box",
            "box" if in_cloud_storage => "Box",
            _ => continue,
        };
        return Some(service);
    }
    let unc = text.starts_with("//") && !text.starts_with("//?/");
    let mounted = ["/volumes/", "/mnt/", "/media/", "/run/media/"].iter().any(|p| text.starts_with(p)) || text.contains("/gvfs/");
    (unc || mounted).then_some("drive")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_sync_provider_from_path() {
        let found = |p: &str| shared_by(Path::new(p));
        for (path, service) in [
            ("/Users/a/Library/Mobile Documents/com~apple~CloudDocs/T.typeshelf", "iCloud Drive"),
            ("/Users/a/Library/CloudStorage/Dropbox/T.typeshelf", "Dropbox"),
            ("/Users/a/Dropbox (Studio)/T.typeshelf", "Dropbox"),
            ("/Users/a/Library/CloudStorage/GoogleDrive-a@b.c/My Drive/T.typeshelf", "Google Drive"),
            ("C:\\Users\\a\\OneDrive - Studio\\T.typeshelf", "OneDrive"),
            ("/Users/a/Library/CloudStorage/Box-Box/T.typeshelf", "Box"),
            ("/Volumes/Studio/T.typeshelf", "drive"),
            ("\\\\server\\fonts\\T.typeshelf", "drive"),
        ] {
            assert_eq!(found(path), Some(service), "{path}");
        }
        for path in ["/Users/a/Documents/Dropbox.typeshelf", "/Users/a/box/T.typeshelf", "C:\\Fonts\\T.typeshelf"] {
            assert_eq!(found(path), None, "{path}");
        }
    }
}
