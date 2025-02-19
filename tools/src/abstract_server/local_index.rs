use async_trait::async_trait;
use flate2::read::GzDecoder;
use futures_core::stream::BoxStream;
use serde_json::{from_str, Value};
use std::io::Read;
use tokio::fs::File;
use tokio::io::AsyncReadExt;

use super::server_interface::{AbstractServer, ErrorDetails, ErrorLayer, Result, ServerError};

use crate::config::{load, TreeConfigPaths};
use crate::file_format::crossref_lookup::CrossrefLookupMap;
use crate::file_format::identifiers::IdentMap;

/// IO errors amount to a 404 for our purposes which means a sticky problem.
impl From<std::io::Error> for ServerError {
    fn from(err: std::io::Error) -> ServerError {
        ServerError::StickyProblem(ErrorDetails {
            layer: ErrorLayer::ServerLayer,
            message: err.to_string(),
        })
    }
}

/// Read newline-delimited JSON that's been gzip-compressed.
async fn read_gzipped_ndjson_from_file(path: &str) -> Result<Vec<Value>> {
    let mut f = File::open(path).await?;
    // We read the entirety to a buffer because
    // https://github.com/serde-rs/json/issues/160 suggests that the buffered
    // reader performance is likely to be much worse.
    //
    // When we want to go async here,
    // https://github.com/rust-lang/flate2-rs/pull/214 suggests that we want to
    // use the `async-compression` crate.
    let mut buffer = Vec::new();
    f.read_to_end(&mut buffer).await?;

    let mut gz = GzDecoder::new(&buffer[..]);

    let mut raw_str = String::new();
    gz.read_to_string(&mut raw_str)?;

    // let mut raw_str = String::new();
    // f.read_to_string(&mut raw_str).await?;

    raw_str
        .lines()
        .map(|s| from_str(s).map_err(|e| ServerError::from(e)))
        .collect()
}

#[allow(dead_code)]
#[derive(Debug)]
struct LocalIndex {
    // We only hold onto the TreeConfigPaths portion of the config because the
    // git data is not `Sync`.  Specifically, the compiler says:
    //
    // "within `TreeConfig`, the trait `Sync` is not implemented for
    // `*mut libgit2_sys::git_repository`"
    //
    // When we need to do local git stuff, we will be able to accomplish this by
    // creating a new `git2::Repository` on demand from the git path.  This is
    // already done in `build-blame.rs` for its compute threads and that's
    // likely the model we should use.
    config_paths: TreeConfigPaths,
    tree_name: String,
    // Note: IdentMap internally handles the identifiers db not existing
    ident_map: IdentMap,
    // But for crossref, it's on us.
    crossref_lookup_map: Option<CrossrefLookupMap>,
}

#[async_trait]
impl AbstractServer for LocalIndex {
    fn translate_analysis_path(&self, sf_path: &str) -> Result<String> {
        Ok(format!(
            "{}/analysis/{}.gz",
            self.config_paths.index_path, sf_path
        ))
    }

    async fn fetch_raw_analysis(&self, sf_path: &str) -> Result<BoxStream<Value>> {
        let full_path = format!("{}/analysis/{}.gz", self.config_paths.index_path, sf_path);
        let values = read_gzipped_ndjson_from_file(&full_path).await?;
        Ok(Box::pin(tokio_stream::iter(values)))
    }

    async fn fetch_html(&self, sf_path: &str) -> Result<String> {
        let full_path = format!("{}/file/{}.gz", self.config_paths.index_path, sf_path);

        // If we were dealing with uncompressed files.
        /*
        let mut f = File::open(full_path).await?;
        let mut raw_str = String::new();
        f.read_to_string(&mut raw_str).await?;
        */

        let mut f = File::open(full_path).await?;
        let mut buffer = Vec::new();
        f.read_to_end(&mut buffer).await?;

        // When we want to go async here,
        // https://github.com/rust-lang/flate2-rs/pull/214 suggests that we want
        // to use the `async-compression` crate.
        let mut gz = GzDecoder::new(&buffer[..]);

        let mut raw_str = String::new();
        gz.read_to_string(&mut raw_str)?;

        Ok(raw_str)
    }

    async fn crossref_lookup(&self, symbol: &str) -> Result<Value> {
        match &self.crossref_lookup_map {
            Some(crossref) => crossref.lookup(symbol),
            None => Ok(Value::Null),
        }
    }

    async fn search_identifiers(
        &self,
        needle: &str,
        exact_match: bool,
        ignore_case: bool,
        match_limit: usize,
    ) -> Result<Vec<(String, String)>> {
        let mut results = vec![];
        for ir in self
            .ident_map
            .lookup(needle, exact_match, ignore_case, match_limit)
        {
            results.push((ir.symbol, ir.id));
        }
        Ok(results)
    }

    async fn perform_query(&self, _q: &str) -> Result<Value> {
        // TODO: For this to work, we want to be able to directly invoke the
        // underpinnings of the web server, which entails porting router.py into
        // web-server.rs, an act which may involve building it on some of this
        // infrastructure...
        Err(ServerError::Unsupported)
    }
}

pub fn make_local_server(
    config_path: &str,
    tree_name: &str,
) -> Result<Box<dyn AbstractServer + Send + Sync>> {
    let mut config = load(config_path, false);
    let tree_config = match config.trees.remove(&tree_name.to_string()) {
        Some(t) => t,
        None => {
            return Err(ServerError::StickyProblem(ErrorDetails {
                layer: ErrorLayer::BadInput,
                message: format!("bad tree name: {}", &tree_name),
            }))
        }
    };

    let ident_path = format!("{}/identifiers", tree_config.paths.index_path);
    let ident_map = IdentMap::new(&ident_path);

    let crossref_path = format!("{}/crossref", tree_config.paths.index_path);
    let crossref_extra_path = format!("{}/crossref-extra", tree_config.paths.index_path);

    let crossref_lookup_map = CrossrefLookupMap::new(&crossref_path, &crossref_extra_path);

    Ok(Box::new(LocalIndex {
        // We don't need the blame_map and hg_map (yet)
        config_paths: tree_config.paths,
        tree_name: tree_name.to_string(),
        ident_map,
        crossref_lookup_map,
    }))
}
