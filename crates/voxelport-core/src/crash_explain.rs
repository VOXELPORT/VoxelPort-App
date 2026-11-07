//! Turns the last lines of a server's console into plain-language explanations of why it stopped, each with a suggested fix.
//! Ported from `crashExplain.js` and `crashExplain.hinglish.js`. Rules are ordered most-specific first; the generic "it crashed"
//! rule only applies when nothing more specific matched.
//!
//! A diagnosis is `{ id, title, detail, fix: { action, label } | null, evidence }` where `action` is `settings` (open the Settings
//! screen), `folder` (open the server folder) or `eula` (accept the EULA for an imported server).

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Value};

/// What was worked out from the console, for the wording of a diagnosis.
#[derive(Default, Debug)]
pub struct Context {
    pub port: Option<u64>,
    pub mods: Vec<String>,
    pub missing: Vec<String>,
    pub plugin: Option<String>,
    pub mixin_mod: Option<String>,
    pub description: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lang {
    English,
    Hinglish,
}

struct Rule {
    id: &'static str,
    test: Regex,
    title: &'static str,
    /// `(action, English label)`.
    fix: Option<(&'static str, &'static str)>,
}

fn rx(pattern: &str) -> Regex {
    Regex::new(pattern).unwrap()
}

const ID_PORT: &str = "port-in-use";
const ID_HEAP: &str = "heap-too-big";
const ID_OOM: &str = "out-of-memory";
const ID_EULA: &str = "eula";
const ID_WRONG_MC: &str = "mod-wrong-minecraft";
const ID_MISSING: &str = "mod-missing-dependency";
const ID_MIXIN: &str = "mixin";
const ID_JAR: &str = "bad-jar";
const ID_LOCKED: &str = "world-locked";
const ID_PERMISSION: &str = "no-permission";
const ID_PLUGIN: &str = "plugin-failed";
const ID_CRASHED: &str = "crashed";

fn rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let folder = Some(("folder", "Open the server folder"));
        vec![
            Rule { id: ID_PORT, test: rx(r"(?i)FAILED TO BIND TO PORT|Address already in use|BindException"), title: "The port is already in use", fix: Some(("settings", "Change the port")) },
            Rule { id: ID_HEAP, test: rx(r"(?i)Could not reserve enough space for (?:object heap|[0-9]+KB object heap)|Invalid maximum heap size|Initial heap size set to a larger value|There is insufficient memory for the Java Runtime"), title: "Too much RAM requested", fix: Some(("settings", "Lower the RAM")) },
            Rule { id: ID_OOM, test: rx(r"java\.lang\.OutOfMemoryError"), title: "The server ran out of memory", fix: Some(("settings", "Give it more RAM")) },
            Rule { id: ID_EULA, test: rx(r"(?i)You need to agree to the EULA"), title: "The Minecraft EULA hasn't been accepted", fix: Some(("eula", "I agree to the EULA")) },
            Rule { id: ID_WRONG_MC, test: rx(r"(?i)(?:requires|depends on)[^\n]*\bminecraft\b[^\n]*(?:but only the wrong version is present|which is missing)|Incompatible mod set"), title: "A mod is made for a different Minecraft version", fix: folder },
            Rule { id: ID_MISSING, test: rx(r"(?i)requires (?:any version|version [^\s]+|[^\s]+) of (?:mod )?'?[A-Za-z0-9_ .-]+'?.*which is missing|Mod resolution failed|Incompatible mods? found"), title: "A mod is missing something it needs", fix: folder },
            Rule { id: ID_MIXIN, test: rx(r"(?i)Mixin apply(?: for mod ([A-Za-z0-9_-]+))? failed|MixinApplyError|InvalidMixinException|MixinTransformerError"), title: "A mod isn't compatible", fix: folder },
            Rule { id: ID_JAR, test: rx(r"(?i)Invalid or corrupt jarfile|Unable to access jarfile|Error: Could not find or load main class"), title: "server.jar is missing or broken", fix: folder },
            Rule { id: ID_LOCKED, test: rx(r"(?i)session\.lock|is already locked|LevelStorageException|The directory .* is locked"), title: "The world is open somewhere else", fix: None },
            Rule { id: ID_PERMISSION, test: rx(r"(?i)AccessDeniedException|Permission denied|Access is denied"), title: "The server can't write to its folder", fix: folder },
            Rule { id: ID_PLUGIN, test: rx(r"(?i)Could not load '?plugins[\\/]([^'\s]+)'?|Error occurred while enabling ([A-Za-z0-9_-]+)"), title: "A plugin failed to load", fix: folder },
        ]
    })
}

/// The generic rule never matches a line (it only applies when the server crashed and nothing else matched), so its pattern cannot match.
fn generic() -> Rule {
    Rule { id: ID_CRASHED, test: rx(r"[^\s\S]"), title: "The server crashed", fix: Some(("folder", "Open the server folder")) }
}

fn mod_list(ctx: &Context, hinglish: bool) -> String {
    if ctx.mods.is_empty() {
        return String::new();
    }
    let mut unique: Vec<&String> = Vec::new();
    for m in &ctx.mods {
        if !unique.contains(&m) {
            unique.push(m);
        }
    }
    let names: Vec<String> = unique.iter().take(3).map(|m| format!("\"{m}\"")).collect();
    match (names.len() == 1, hinglish) {
        (true, false) => format!("The mod {}", names[0]),
        (false, false) => format!("The mods {}", names.join(", ")),
        (true, true) => format!("Mod {}", names[0]),
        (false, true) => format!("Mods {}", names.join(", ")),
    }
}

fn or<'a>(s: &'a str, fallback: &'a str) -> &'a str {
    if s.is_empty() { fallback } else { s }
}

fn detail_en(id: &str, ctx: &Context) -> String {
    match id {
        ID_PORT => format!(
            "Another program — often another Minecraft server — is already using port {}. Close the other program, or give this server a different port in Settings.",
            ctx.port.filter(|p| *p != 0).map_or("this server uses".to_string(), |p| p.to_string())
        ),
        ID_HEAP => "Java couldn't get the amount of memory this server is set to use. Lower the RAM slider in Settings and start again.".into(),
        ID_OOM => "The world, players or mods needed more RAM than the server has. Raise the RAM in Settings, lower the view distance, or remove heavy mods.".into(),
        ID_EULA => "Every Minecraft server must agree to Mojang's EULA (minecraft.net/eula) before it can start.".into(),
        ID_WRONG_MC => format!("{} doesn't support this Minecraft version. Download the version of that mod made for this server's version, or remove it from the mods folder.", or(&mod_list(ctx, false), "One of the mods")),
        ID_MISSING => format!(
            "{} needs another mod that isn't installed{}. Add the missing mod to the mods folder — most Fabric mods need Fabric API.",
            or(&mod_list(ctx, false), "A mod"),
            if ctx.missing.is_empty() { String::new() } else { format!(" ({})", ctx.missing.join(", ")) }
        ),
        ID_MIXIN => format!(
            "{} failed to load into this Minecraft version. Update it, or remove it from the mods folder.",
            ctx.mixin_mod.as_ref().map_or("A mod".to_string(), |m| format!("The mod \"{m}\""))
        ),
        ID_JAR => "The server file couldn't be opened. If you moved or replaced server.jar, put a working one back — or add this server again to download a fresh copy.".into(),
        ID_LOCKED => "Another Minecraft server or program is using this world folder. Close it (check Task Manager for java.exe) and start again.".into(),
        ID_PERMISSION => "Windows blocked the server from saving files. The folder may be read-only or synced by OneDrive — move the server to a normal folder such as Documents.".into(),
        ID_PLUGIN => format!(
            "{} couldn't start — usually because it's made for a different Minecraft version. Update or remove it from the plugins folder.",
            ctx.plugin.as_ref().map_or("A plugin".to_string(), |p| format!("\"{p}\""))
        ),
        _ => match &ctx.description {
            Some(d) => format!("Minecraft says: \"{d}\". A full crash report was saved in the server's crash-reports folder."),
            None => format!("The server stopped unexpectedly{}. Check the console above for the first red error.", ctx.last_error.as_ref().map_or(String::new(), |e| format!(" with: {e}"))),
        },
    }
}

/// `(title, detail, fix label)` in Hinglish (Hindi in the English alphabet).
fn hinglish(id: &str, ctx: &Context) -> Option<(&'static str, String, &'static str)> {
    const FOLDER: &str = "Server folder kholo";
    Some(match id {
        ID_PORT => ("Port pehle se use mein hai", format!("Koi aur program — aksar doosra Minecraft server — port {} pehle se use kar raha hai. Doosra program band karo, ya Settings mein is server ko alag port do.", ctx.port.filter(|p| *p != 0).map_or("jo yeh server use karta hai".to_string(), |p| p.to_string())), "Port badlo"),
        ID_HEAP => ("Bahut zyada RAM maangi gayi", "Java ko utni memory nahi mili jitni is server ke liye set hai. Settings mein RAM slider kam karo aur dobara start karo.".into(), "RAM kam karo"),
        ID_OOM => ("Server ki memory khatam ho gayi", "World, players ya mods ko server ki RAM se zyada memory chahiye thi. Settings mein RAM badhao, view distance kam karo, ya bhaari mods hatao.".into(), "Zyada RAM do"),
        ID_EULA => ("Minecraft EULA manzoor nahi kiya gaya", "Har Minecraft server ko start hone se pehle Mojang ka EULA (minecraft.net/eula) manzoor karna padta hai.".into(), "Main EULA se sehmat hoon"),
        ID_WRONG_MC => ("Ek mod doosre Minecraft version ke liye bana hai", format!("{} is Minecraft version ko support nahi karta. Us mod ka is server ke version wala version download karo, ya use mods folder se hata do.", or(&mod_list(ctx, true), "Ek mod")), FOLDER),
        ID_MISSING => ("Ek mod ko kuch chahiye jo maujood nahi hai", format!("{} ko ek aur mod chahiye jo install nahi hai{}. Missing mod ko mods folder mein daalo — zyada tar Fabric mods ko Fabric API chahiye.", or(&mod_list(ctx, true), "Ek mod"), if ctx.missing.is_empty() { String::new() } else { format!(" ({})", ctx.missing.join(", ")) }), FOLDER),
        ID_MIXIN => ("Ek mod compatible nahi hai", format!("{} is Minecraft version mein load nahi ho paya. Use update karo, ya mods folder se hata do.", ctx.mixin_mod.as_ref().map_or("Ek mod".to_string(), |m| format!("Mod \"{m}\""))), FOLDER),
        ID_JAR => ("server.jar missing ya kharab hai", "Server file khul nahi payi. Agar tumne server.jar hataya ya badla hai, to chalne wali file wapas rakho — ya server ko dobara jodo taaki nayi copy download ho.".into(), FOLDER),
        ID_LOCKED => ("World kahin aur khuli hui hai", "Koi aur Minecraft server ya program is world folder ko use kar raha hai. Use band karo (Task Manager mein java.exe dekho) aur dobara start karo.".into(), ""),
        ID_PERMISSION => ("Server apne folder mein likh nahi pa raha", "Windows ne server ko files save karne se roka. Folder read-only ho sakta hai ya OneDrive usse sync kar raha ho — server ko Documents jaise normal folder mein le jao.".into(), FOLDER),
        ID_PLUGIN => ("Ek plugin load nahi hua", format!("{} start nahi ho paya — aksar isliye ki woh doosre Minecraft version ke liye bana hai. Use update karo ya plugins folder se hata do.", ctx.plugin.as_ref().map_or("Ek plugin".to_string(), |p| format!("\"{p}\""))), FOLDER),
        ID_CRASHED => ("Server crash ho gaya", match &ctx.description {
            Some(d) => format!("Minecraft kehta hai: \"{d}\". Poori crash report server ke crash-reports folder mein save hui hai."),
            None => format!("Server achanak band ho gaya{}. Upar console mein pehla laal error dekho.", ctx.last_error.as_ref().map_or(String::new(), |e| format!(" is error ke saath: {e}"))),
        }, FOLDER),
        _ => return None,
    })
}

fn truncate(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn to_diagnosis(rule: &Rule, ctx: &Context, evidence: &str, lang: Lang) -> Value {
    let evidence = truncate(evidence, 300);
    let fix_en = rule.fix.map(|(action, label)| json!({ "action": action, "label": label }));
    if lang == Lang::Hinglish {
        if let Some((title, detail, label)) = hinglish(rule.id, ctx) {
            let fix = match (rule.fix, label.is_empty()) {
                (Some((action, _)), false) => json!({ "action": action, "label": label }),
                _ => fix_en.clone().unwrap_or(Value::Null),
            };
            return json!({ "id": rule.id, "title": title, "detail": detail, "fix": fix, "evidence": evidence });
        }
    }
    json!({ "id": rule.id, "title": rule.title, "detail": detail_en(rule.id, ctx), "fix": fix_en.unwrap_or(Value::Null), "evidence": evidence })
}

fn context(lines: &[String], port: Option<u64>) -> Context {
    static MOD: OnceLock<Regex> = OnceLock::new();
    static MIXIN: OnceLock<Regex> = OnceLock::new();
    static PLUGIN_A: OnceLock<Regex> = OnceLock::new();
    static PLUGIN_B: OnceLock<Regex> = OnceLock::new();
    static ERROR: OnceLock<Regex> = OnceLock::new();
    static PREFIX: OnceLock<Regex> = OnceLock::new();
    let mod_re = MOD.get_or_init(|| rx(r"Mod '([^']+)' \([A-Za-z0-9_-]+\) [^\s]+ (?:requires|depends on)[^']*'([^']+)'"));
    let mixin_re = MIXIN.get_or_init(|| rx(r"(?i)Mixin apply for mod ([A-Za-z0-9_-]+) failed"));
    let plugin_a = PLUGIN_A.get_or_init(|| rx(r"(?i)Could not load '?plugins[\\/]([^'\s]+)'?"));
    let plugin_b = PLUGIN_B.get_or_init(|| rx(r"(?i)Error occurred while enabling ([A-Za-z0-9_-]+)"));
    let error_re = ERROR.get_or_init(|| rx(r"(?:Exception|Error)(?::|\b)"));
    let prefix_re = PREFIX.get_or_init(|| rx(r"^\[[^\]]*\]\s*(?:\[[^\]]*\]:?\s*)?"));

    let mut ctx = Context { port, ..Context::default() };
    for line in lines {
        if let Some(m) = mod_re.captures(line) {
            ctx.mods.push(m[1].to_string());
            if !m[2].eq_ignore_ascii_case("minecraft") && !line.contains("wrong version") {
                ctx.missing.push(m[2].to_string());
            }
        }
        if let Some(m) = mixin_re.captures(line) {
            ctx.mixin_mod = Some(m[1].to_string());
        }
        if ctx.plugin.is_none() {
            if let Some(m) = plugin_a.captures(line).or_else(|| plugin_b.captures(line)) {
                ctx.plugin = Some(m[1].to_string());
            }
        }
        if let Some(rest) = line.trim().strip_prefix("Description: ").filter(|r| !r.is_empty()) {
            ctx.description = Some(truncate(rest, 160));
        }
        if ctx.last_error.is_none() && error_re.is_match(line) && !line.trim_start_matches([' ', '\t']).starts_with("at ") {
            ctx.last_error = Some(truncate(prefix_re.replace(line, "").trim(), 160));
        }
    }
    let mut unique: Vec<String> = Vec::new();
    for m in std::mem::take(&mut ctx.missing) {
        if !unique.contains(&m) {
            unique.push(m);
        }
    }
    unique.truncate(3);
    ctx.missing = unique;
    ctx
}

/// Explains why a server stopped. `lines` are the recent console lines, oldest first. Returns at most three diagnoses, most
/// relevant first (empty when nothing matched and the server did not crash).
pub fn explain_crash(lines: &[String], port: Option<u64>, crashed: bool, lang: Lang) -> Vec<Value> {
    let ctx = context(lines, port);
    let mut found: Vec<(&str, Value)> = Vec::new();
    for rule in rules() {
        if let Some(evidence) = lines.iter().find(|l| rule.test.is_match(l)) {
            found.push((rule.id, to_diagnosis(rule, &ctx, evidence, lang)));
        }
    }
    // "Wrong Minecraft version" is the more useful reading of a resolution failure.
    if found.iter().any(|(id, _)| *id == ID_WRONG_MC) && ctx.missing.is_empty() {
        if let Some(i) = found.iter().position(|(id, _)| *id == ID_MISSING) {
            found.remove(i);
        }
    }
    if found.is_empty() && crashed {
        let g = generic();
        found.push((ID_CRASHED, to_diagnosis(&g, &ctx, ctx.last_error.as_deref().unwrap_or(""), lang)));
    }
    found.into_iter().take(3).map(|(_, v)| v).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(l: &[&str]) -> Vec<String> {
        l.iter().map(|s| s.to_string()).collect()
    }

    fn ids(v: &[Value]) -> Vec<String> {
        v.iter().map(|d| d["id"].as_str().unwrap().to_string()).collect()
    }

    fn one(line: &str) -> Vec<String> {
        ids(&explain_crash(&lines(&[line]), Some(25565), true, Lang::English))
    }

    #[test]
    fn each_known_problem_is_recognised_from_a_real_looking_console_line() {
        for (line, id) in [
            ("[Server thread/ERROR]: **** FAILED TO BIND TO PORT!", ID_PORT),
            ("java.net.BindException: Address already in use: bind", ID_PORT),
            ("Error occurred during initialization of VM\nCould not reserve enough space for 8388608KB object heap", ID_HEAP),
            ("Error: Could not reserve enough space for object heap", ID_HEAP),
            ("Exception in thread \"main\" java.lang.OutOfMemoryError: Java heap space", ID_OOM),
            ("[main/WARN]: You need to agree to the EULA in order to run the server. Go to eula.txt for more info.", ID_EULA),
            ("Mod 'Sodium' (sodium) 0.5.0 requires version 1.21 of minecraft, which is missing!", ID_WRONG_MC),
            ("Incompatible mod set found!", ID_WRONG_MC),
            ("Mod resolution failed", ID_MISSING),
            ("Mixin apply for mod lithium failed lithium.mixins.json:x", ID_MIXIN),
            ("Error: Unable to access jarfile server.jar", ID_JAR),
            ("Error: Invalid or corrupt jarfile server.jar", ID_JAR),
            ("net.minecraft.world.level.storage.LevelStorageException: Failed to acquire session.lock", ID_LOCKED),
            ("java.nio.file.AccessDeniedException: C:\\x\\world", ID_PERMISSION),
            ("[ERROR]: Could not load 'plugins\\Broken.jar' in folder 'plugins'", ID_PLUGIN),
            ("[ERROR]: Error occurred while enabling Essentials v2.20 (Is it up to date?)", ID_PLUGIN),
        ] {
            assert!(one(line).contains(&id.to_string()), "{line:?} → {:?}", one(line));
        }
    }

    #[test]
    fn a_crash_nothing_matches_gets_the_generic_explanation_and_a_clean_stop_gets_none() {
        let out = explain_crash(&lines(&["[12:00:00] [Server thread/ERROR]: Exception ticking world", "Description: Ticking entity"]), None, true, Lang::English);
        assert_eq!(ids(&out), [ID_CRASHED]);
        assert!(out[0]["detail"].as_str().unwrap().contains("Minecraft says: \"Ticking entity\""), "{}", out[0]);
        assert_eq!(out[0]["fix"], json!({ "action": "folder", "label": "Open the server folder" }));
        let plain = explain_crash(&lines(&["[12:00:00] [Server thread/ERROR]: java.lang.IllegalStateException: boom", "\tat x.y.Z(Z.java:1)"]), None, true, Lang::English);
        assert!(plain[0]["detail"].as_str().unwrap().contains("with: java.lang.IllegalStateException: boom"), "{}", plain[0]);
        assert!(explain_crash(&lines(&["Stopping server", "Saving worlds"]), None, false, Lang::English).is_empty());
        assert!(explain_crash(&[], None, true, Lang::English).len() == 1, "even an empty console explains a crash");
    }

    #[test]
    fn the_wording_names_the_port_the_mods_the_missing_ones_and_the_plugin() {
        let port = explain_crash(&lines(&["FAILED TO BIND TO PORT"]), Some(25570), true, Lang::English);
        assert!(port[0]["detail"].as_str().unwrap().contains("port 25570"), "{}", port[0]);
        assert!(explain_crash(&lines(&["FAILED TO BIND TO PORT"]), None, true, Lang::English)[0]["detail"].as_str().unwrap().contains("port this server uses"));
        let mods = explain_crash(&lines(&["Mod 'Create' (create) 0.5 requires any version of 'flywheel', which is missing!", "Mod 'Create' (create) 0.5 requires any version of 'registrate', which is missing!", "Mod resolution failed"]), None, true, Lang::English);
        let d = mods[0]["detail"].as_str().unwrap();
        assert!(d.starts_with("The mod \"Create\" needs another mod that isn't installed (flywheel, registrate)."), "{d}");
        let plugin = explain_crash(&lines(&["Could not load 'plugins/Cool.jar' in folder 'plugins'"]), None, true, Lang::English);
        assert!(plugin[0]["detail"].as_str().unwrap().starts_with("\"Cool.jar\" couldn't start"), "{}", plugin[0]);
        let mixin = explain_crash(&lines(&["Mixin apply for mod lithium failed x.json"]), None, true, Lang::English);
        assert!(mixin[0]["detail"].as_str().unwrap().starts_with("The mod \"lithium\" failed to load"), "{}", mixin[0]);
    }

    #[test]
    fn a_wrong_minecraft_version_hides_the_vaguer_missing_dependency_reading() {
        let out = explain_crash(&lines(&["Mod 'Sodium' (sodium) 0.5.0 requires version 1.21 of minecraft, but only the wrong version is present: 1.20.1!", "Mod resolution failed"]), None, true, Lang::English);
        assert_eq!(ids(&out), [ID_WRONG_MC]);
        // With a really missing mod too, both are kept.
        let both = explain_crash(&lines(&["Mod 'Sodium' (sodium) 0.5.0 requires version 1.21 of minecraft, but only the wrong version is present: 1.20.1!", "Mod 'Create' (create) 0.5 requires any version of 'flywheel', which is missing!"]), None, true, Lang::English);
        assert_eq!(ids(&both), [ID_WRONG_MC, ID_MISSING]);
    }

    #[test]
    fn at_most_three_are_shown_and_each_carries_its_evidence_cut_short() {
        let long = format!("FAILED TO BIND TO PORT {}", "x".repeat(400));
        let out = explain_crash(&lines(&[&long, "java.lang.OutOfMemoryError", "You need to agree to the EULA", "Invalid or corrupt jarfile x", "Permission denied"]), None, true, Lang::English);
        assert_eq!(out.len(), 3);
        assert_eq!(ids(&out), [ID_PORT, ID_OOM, ID_EULA]);
        assert_eq!(out[0]["evidence"].as_str().unwrap().chars().count(), 300);
    }

    #[test]
    fn the_world_locked_explanation_has_no_fix_button() {
        let out = explain_crash(&lines(&["Failed to acquire session.lock"]), None, true, Lang::English);
        assert_eq!(out[0]["fix"], Value::Null);
        let hn = explain_crash(&lines(&["Failed to acquire session.lock"]), None, true, Lang::Hinglish);
        assert_eq!(hn[0]["fix"], Value::Null);
    }

    #[test]
    fn every_rule_has_hinglish_wording_with_the_same_actions() {
        let ctx = Context::default();
        for r in rules().iter().chain(std::iter::once(&generic())) {
            let en = to_diagnosis(r, &ctx, "e", Lang::English);
            let hn = to_diagnosis(r, &ctx, "e", Lang::Hinglish);
            assert_ne!(en["title"], hn["title"], "{} has no Hinglish title", r.id);
            assert_ne!(en["detail"], hn["detail"], "{} has no Hinglish detail", r.id);
            assert_eq!(en["fix"].is_null(), hn["fix"].is_null(), "{}", r.id);
            if !en["fix"].is_null() {
                assert_eq!(en["fix"]["action"], hn["fix"]["action"], "{} keeps its action", r.id);
                assert_ne!(en["fix"]["label"], hn["fix"]["label"], "{} has no Hinglish label", r.id);
            }
        }
        let out = explain_crash(&lines(&["FAILED TO BIND TO PORT"]), Some(25565), true, Lang::Hinglish);
        assert_eq!(out[0]["title"], "Port pehle se use mein hai");
        assert_eq!(out[0]["fix"], json!({ "action": "settings", "label": "Port badlo" }));
        assert!(out[0]["detail"].as_str().unwrap().contains("port 25565"));
    }
}
