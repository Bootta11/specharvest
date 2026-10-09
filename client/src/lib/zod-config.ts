import { config } from "zod";

// The server's CSP has no 'unsafe-eval'. Zod would otherwise probe `new Function` once (caught, but reported as a
// CSP violation) to decide whether to JIT-compile schemas; jitless skips the probe and uses its plain parser.
config({ jitless: true });
