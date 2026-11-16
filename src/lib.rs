use std::{env, fs};

use zed_extension_api::{
    self as zed, serde_json, settings::LspSettings, LanguageServerId,
    LanguageServerInstallationStatus, Result,
};

/// Key under `lsp` in Zed's settings, and the id in extension.toml.
const SERVER_ID: &str = "template-string-converter";

/// npm package that holds the server, and its entry point once installed into
/// the extension's work directory.
const PACKAGE_NAME: &str = "template-string-converter-language-server";
const SERVER_PATH: &str = "node_modules/template-string-converter-language-server/dist/server.js";

struct TemplateStringConverter {
    /// The npm registry is asked for a newer version once per session.
    checked_for_update: bool,
}

impl TemplateStringConverter {
    fn server_is_installed() -> bool {
        fs::metadata(SERVER_PATH).is_ok_and(|stat| stat.is_file())
    }

    /// Installs or updates the server package. A failed update check or
    /// install is only an error when there is no installed copy to fall back
    /// on, so the server keeps working offline.
    fn ensure_server(&mut self, language_server_id: &LanguageServerId) -> Result<()> {
        let installed = Self::server_is_installed();
        if installed && self.checked_for_update {
            return Ok(());
        }

        zed::set_language_server_installation_status(
            language_server_id,
            &LanguageServerInstallationStatus::CheckingForUpdate,
        );
        let update = zed::npm_package_latest_version(PACKAGE_NAME).and_then(|latest| {
            let current = zed::npm_package_installed_version(PACKAGE_NAME)?;
            if installed && current.as_deref() == Some(latest.as_str()) {
                return Ok(());
            }
            zed::set_language_server_installation_status(
                language_server_id,
                &LanguageServerInstallationStatus::Downloading,
            );
            zed::npm_install_package(PACKAGE_NAME, &latest)
        });
        self.checked_for_update = true;

        match update {
            _ if Self::server_is_installed() => Ok(()),
            Err(error) => Err(format!("failed to install {PACKAGE_NAME}: {error}")),
            Ok(()) => Err(format!(
                "{PACKAGE_NAME} was installed but {SERVER_PATH} is missing"
            )),
        }
    }

    /// One settings object for the server, whichever of the two keys the user
    /// filled in: `lsp.<id>.settings` or `lsp.<id>.initialization_options`.
    /// `prefer_settings` picks the winner when both are present.
    fn server_settings(worktree: &zed::Worktree, prefer_settings: bool) -> Option<serde_json::Value> {
        let lsp_settings = LspSettings::for_worktree(SERVER_ID, worktree).ok()?;
        if prefer_settings {
            lsp_settings.settings.or(lsp_settings.initialization_options)
        } else {
            lsp_settings.initialization_options.or(lsp_settings.settings)
        }
    }
}

impl zed::Extension for TemplateStringConverter {
    fn new() -> Self {
        Self {
            checked_for_update: false,
        }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        // `lsp.<id>.binary` replaces the downloaded server, for development or
        // for machines without npm registry access:
        //   "path" + optional "arguments": run that program;
        //   "arguments" alone: run them with the Node that Zed manages.
        let binary = LspSettings::for_worktree(SERVER_ID, worktree)
            .ok()
            .and_then(|settings| settings.binary);
        if let Some(binary) = binary {
            let arguments = binary.arguments.filter(|arguments| !arguments.is_empty());
            if let Some(path) = binary.path {
                return Ok(zed::Command {
                    command: path,
                    args: arguments.unwrap_or_else(|| vec!["--stdio".to_string()]),
                    env: Default::default(),
                });
            }
            if let Some(arguments) = arguments {
                return Ok(zed::Command {
                    command: zed::node_binary_path()?,
                    args: arguments,
                    env: Default::default(),
                });
            }
        }

        self.ensure_server(language_server_id)?;
        let server_path = env::current_dir()
            .map_err(|error| format!("cannot find the extension's work directory: {error}"))?
            .join(SERVER_PATH);
        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![
                server_path.to_string_lossy().to_string(),
                "--stdio".to_string(),
            ],
            env: Default::default(),
        })
    }

    fn language_server_initialization_options(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<serde_json::Value>> {
        Ok(Self::server_settings(worktree, false))
    }

    fn language_server_workspace_configuration(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<serde_json::Value>> {
        Ok(Self::server_settings(worktree, true))
    }
}

zed::register_extension!(TemplateStringConverter);
