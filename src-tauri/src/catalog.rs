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

/// The `server.properties` settings a template starts a server with, as (key, value) pairs; None for an unknown template.
pub fn template_properties(id: &str) -> Option<Vec<(String, String)>> {
    let props = catalog()["templateProperties"].get(id)?.as_object()?;
    Some(props.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string())).collect())
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
        // Every template has its settings, and they come out as plain strings (the backslash in the flat world type survives).
        for t in templates.as_array().unwrap() {
            assert!(template_properties(t["id"].as_str().unwrap()).is_some_and(|p| !p.is_empty()), "{t}");
        }
        assert!(template_properties("creative").unwrap().contains(&("level-type".to_string(), r"minecraft\:flat".to_string())));
        assert!(template_properties("nope").is_none());
    }
}
