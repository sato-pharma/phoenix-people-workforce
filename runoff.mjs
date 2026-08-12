const { runClosingOfficeDifferentiationTests } = await import("./tests/closing-office-differentiation.test.ts");
try { await runClosingOfficeDifferentiationTests(); console.log("PASS"); }
catch (e) { console.log("FAIL:", String(e.message).split("\n")[0].slice(0,150)); process.exitCode = 1; }
