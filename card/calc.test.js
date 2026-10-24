const assert = require("assert");
const c = require("./calc.js");
// Agreement example: PIF $200, POT $30,300 incl. $300 interest -> $899.
assert.strictEqual(c.minimumDue(30300, 300, 200), 899);
// Agreement example: 15.99% APR, ADB $2,250, 30 days -> $29.57.
assert.strictEqual(c.interest(2250, 15.99, 30), 29.57);
// $40 floor, capped at the balance.
assert.strictEqual(c.minimumDue(1000, 10, 0), 40);
assert.strictEqual(c.minimumDue(25, 0, 0), 25);
assert.strictEqual(c.cashAdvanceFee(100), 10);
assert.strictEqual(c.cashAdvanceFee(1000), 50);
// Variable APRs capped at 29.99%.
assert.strictEqual(c.aprs(20).penalty, 29.99);
console.log("all tests passed");
