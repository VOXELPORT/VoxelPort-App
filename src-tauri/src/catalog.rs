//! The lists the screens show that never change at run time: server types, templates, relay regions.
//! They come from catalog.json, which `node tools/gen-catalog.js` writes from the Electron app's own modules.

use std::sync::OnceLock;

use serde_json::Value;

fn catalog() -> &'static Value {
    static C: OnceLock<Value> = OnceLock::new();
    C.get_or_init(|| serde_json::from_str(include_str!("catalog.json")).expect("catalog.json is valid JSON"))
}

pub fn types() -> Value {
    catalog()["types"].clone()
}

pub fn templates() -> Value {
    catalog()["templates"].clone()
}

pub fn regions() -> Value {
    catalog()["regions"].clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_snapshot_has_what_the_screens_need() {
        let types = types();
        let ids: Vec<&str> = types.as_array().unwrap().iter().filter_map(|t| t["id"].as_str()).collect();
        assert_eq!(ids, ["vanilla", "paper", "fabric"]);
        let templates = templates();
        assert!(templates.as_array().unwrap().len() >= 5);
        assert!(templates.as_array().unwrap().iter().all(|t| t["id"].is_string() && t["label"].is_string() && t["type"].is_string() && t["cracked"].is_boolean()));
        let regions = regions();
        let region_ids: Vec<&str> = regions.as_array().unwrap().iter().filter_map(|r| r["id"].as_str()).collect();
        assert_eq!(region_ids, ["in", "eu"]);
    }
}
