/**
 * Step-0 spike, part (c): print what the installed @x402/* packages actually export.
 * No keys, no network, no settlement — pure local module introspection (plan §0.5).
 *
 * Run: npm run spike:introspect
 */

const SUBPATHS = [
  "@x402/express",
  "@x402/fetch",
  "@x402/core",
  "@x402/core/server",
  "@x402/core/types",
  "@x402/evm",
  "@x402/evm/exact/server",
  "@x402/evm/exact/client",
  // advanced schemes referenced by the stretch tracks — may or may not be present:
  "@x402/evm/batch-settlement/client",
  "@x402/evm/batch-settlement/server",
  "@x402/evm/auth-capture/client",
];

async function dump(path: string) {
  try {
    const mod: Record<string, unknown> = await import(path);
    const keys = Object.keys(mod).sort();
    console.log(`\n✅ ${path}`);
    for (const k of keys) {
      const v = (mod as any)[k];
      const kind = typeof v === "function" ? (/^[A-Z]/.test(k) ? "class/ctor?" : "fn") : typeof v;
      console.log(`     ${k}  (${kind})`);
    }
    if (keys.length === 0) console.log("     (no named exports)");
  } catch (err: any) {
    console.log(`\n❌ ${path}  — ${err?.code ?? ""} ${String(err?.message ?? err).split("\n")[0]}`);
  }
}

console.log("=== @x402/* installed export surface ===");
for (const p of SUBPATHS) await dump(p);
console.log("\n=== done ===");

export {}; // make this a module so top-level await is allowed
