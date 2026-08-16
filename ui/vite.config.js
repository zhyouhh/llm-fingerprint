import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const NODE_VENDOR_CONFIG = path.join(REPO, 'src/normalize/vendor-config.js');
const BROWSER_VENDOR_CONFIG = path.join(HERE, 'src/core/vendor-config.browser.js');

/**
 * 🔴 The one platform swap in the whole build.
 *
 * src/normalize/vendor-config.js reads two JSON files off disk under Node; in the browser
 * they are bundled imports. Everything else in src/ — normalisation, distances,
 * thresholds, verdicts — is the same code the CLI and the golden tests run.
 *
 * Done as a resolveId hook rather than resolve.alias because alias matches the import
 * SPECIFIER, and the same module is imported as './vendor-config.js' from core.js and as
 * '../normalize/vendor-config.js' from runner.js. A pattern loose enough to catch both is
 * loose enough to catch the wrong file; resolving first and comparing the absolute path
 * cannot. If this silently stopped matching, the build would pull `node:fs` into the
 * bundle and the page would break at runtime — so it also throws if the target is gone.
 */
function browserVendorConfig() {
  return {
    name: 'llmfp:vendor-config-browser',
    enforce: 'pre',
    applyToEnvironment: (env) => env.name === 'client',
    async resolveId(source, importer, options) {
      if (!source.endsWith('vendor-config.js')) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved || path.normalize(resolved.id) !== NODE_VENDOR_CONFIG) return null;
      return BROWSER_VENDOR_CONFIG;
    },
  };
}

export default defineConfig({
  plugins: [browserVendorConfig(), cloudflare()],
  resolve: {
    // vendor/ and src/ live above ui/; keep them out of the pre-bundler's way.
    preserveSymlinks: false,
  },
  server: {
    fs: { allow: [REPO] },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
