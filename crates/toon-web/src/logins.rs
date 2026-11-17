//! Contas dos sites que pedem login para ler, em `site-logins.env` (só neste PC). O app entra sozinho
//! quando o site manda para a página de login; a senha vai só para o próprio site e nunca para logs.

use std::sync::LazyLock;

use regex::Regex;
use toon_core::paths::site_logins_file;

use crate::browser::Tab;

const TEMPLATE: &str = "# Contas dos sites que pedem login para ler (o Toon Index entra sozinho quando o site mandar para a página de login).
# Um site por par de linhas, com o nome do site sem \"www.\" e sem o final (mediocrescan.com -> MEDIOCRESCAN).
# Este arquivo fica só neste PC; a senha vai só para o próprio site.

MEDIOCRESCAN_USER=
MEDIOCRESCAN_PASSWORD=
";

static LOGIN_PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)/(entrar|login|signin|sign-in|auth)(/|$|\?)").unwrap());

/// Cria o arquivo com as linhas vazias, para a pessoa preencher, quando ainda não existe.
pub fn ensure_file() -> std::path::PathBuf {
    let path = site_logins_file();
    if !path.exists() {
        let _ = std::fs::write(&path, TEMPLATE);
    }
    path
}

fn site_key(url: &str) -> String {
    let host = url::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
    let labels: Vec<&str> = host.trim_start_matches("www.").split('.').collect();
    let base = if labels.len() > 1 { labels[..labels.len() - 1].join("_") } else { labels[0].to_string() };
    base.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' }).collect()
}

struct Login {
    user: String,
    password: String,
}

fn login_for(url: &str) -> Option<Login> {
    static LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$").unwrap());
    let text = std::fs::read_to_string(site_logins_file()).ok()?;
    let key = site_key(url);
    let value = |name: String| {
        text.lines().find_map(|line| {
            let m = LINE.captures(line)?;
            (m[1] == name).then(|| m[2].trim_matches(|c| c == '"' || c == '\'').to_string())
        })
    };
    let user = value(format!("{key}_USER")).filter(|v| !v.is_empty())?;
    let password = value(format!("{key}_PASSWORD")).filter(|v| !v.is_empty())?;
    Some(Login { user, password })
}

fn on_login_page(url: &str) -> bool {
    url::Url::parse(url).is_ok_and(|u| LOGIN_PATH.is_match(&format!("{}{}", u.path(), u.query().map(|q| format!("?{q}")).unwrap_or_default())))
}

/// Mandado para a página de login: entra com a conta do arquivo, quando há uma, e volta para `url`.
pub async fn sign_in_if_asked(tab: &Tab, url: &str) -> bool {
    let here = tab.url().await;
    if !on_login_page(&here) {
        return false;
    }
    let Some(login) = login_for(&here) else { return false };
    let script = format!(
        r#"(async () => {{
    const shown = (el) => el && el.getClientRects().length > 0
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    let password = null
    for (let i = 0; i < 20 && !password; i++) {{
      password = [...document.querySelectorAll('input[type=password]')].find(shown)
      if (!password) await wait(250)
    }}
    if (!password) {{
      const other = [...document.querySelectorAll('button, a')].find((b) => /usar outra conta|use another account|outra conta/i.test(b.innerText))
      other?.click()
      await wait(800)
      password = [...document.querySelectorAll('input[type=password]')].find(shown)
    }}
    if (!password) return false
    const form = password.closest('form') || document
    const user = [...form.querySelectorAll('input[type=email], input[type=text], input[name*=user i], input[name*=email i], input:not([type])')].find(shown)
    if (!user) return false
    const set = (input, value) => {{
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, value)
      input.dispatchEvent(new Event('input', {{ bubbles: true }}))
      input.dispatchEvent(new Event('change', {{ bubbles: true }}))
    }}
    set(user, {user})
    set(password, {password})
    for (const box of form.querySelectorAll('input[type=checkbox]')) {{
      const label = (box.closest('label')?.innerText || box.parentElement?.innerText || '')
      if (/manter|lembrar|remember|keep/i.test(label) && !box.checked) box.click()
    }}
    for (const box of form.querySelectorAll('[role=checkbox][aria-checked=false]')) {{
      if (/manter|lembrar|remember|keep/i.test(box.innerText || box.getAttribute('aria-label') || '')) box.click()
    }}
    const submit = [...form.querySelectorAll('button[type=submit], input[type=submit], button')].find((b) => shown(b) && /entrar|login|sign in|acessar/i.test(b.innerText || b.value))
    if (submit) submit.click()
    else password.form?.requestSubmit()
    return true
  }})()"#,
        user = serde_json::to_string(&login.user).unwrap_or_default(),
        password = serde_json::to_string(&login.password).unwrap_or_default(),
    );
    drop(login);
    if !tab.eval::<bool>(&script).await.unwrap_or(false) {
        return false;
    }
    // O site aceita a conta e segue (para a página pedida ou para o início).
    for _ in 0..20 {
        if !on_login_page(&tab.url().await) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    if on_login_page(&tab.url().await) {
        return false;
    }
    tab.open(url).await.is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys() {
        assert_eq!(site_key("https://www.mediocrescan.com/obra/1"), "MEDIOCRESCAN");
        assert!(on_login_page("https://x.com/entrar?next=/a"));
        assert!(!on_login_page("https://x.com/obra/entrar-no-jogo"));
    }
}
