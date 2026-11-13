// Formulas from the Card Member Agreement (as of 06/30/2026).
(function (root) {
  // Part 1, "How We Calculate the Amount Due Each Month".
  function minimumDue(potBalance, interest, pifBalance, pastDue) {
    pastDue = pastDue || 0;
    if (potBalance <= 0) return round2(pifBalance + pastDue);
    var amount = potBalance - interest;
    var tiered =
      0.01 * Math.min(Math.max(amount, 0), 20000) +
      0.02 * Math.min(Math.max(amount - 20000, 0), 15000) +
      0.05 * Math.min(Math.max(amount - 35000, 0), 15000) +
      0.10 * Math.max(amount - 50000, 0);
    var rate = amount > 0 ? Math.round((tiered / amount) * 10000) / 10000 : 0;
    var option3 = Math.round(amount * rate) + interest;
    var potMin = Math.min(Math.max(40, 0.02 * potBalance, option3), potBalance);
    return round2(potMin + pastDue + pifBalance);
  }

  // Part 2, "How we calculate interest": ADB x DPR x days, DPR = APR/365 rounded to 0.0001%.
  function interest(avgDailyBalance, aprPercent, days) {
    var dpr = Math.round((aprPercent / 365) * 10000) / 10000;
    return round2(avgDailyBalance * (dpr / 100) * days);
  }

  function aprs(prime) {
    var cap = 29.99;
    return {
      payOverTime: Math.min(prime + 12.74, cap),
      cashAdvance: Math.min(prime + 21.99, cap),
      penalty: Math.min(prime + 26.74, cap)
    };
  }

  function cashAdvanceFee(amount) {
    return round2(Math.max(10, 0.05 * amount));
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  var api = { minimumDue: minimumDue, interest: interest, aprs: aprs, cashAdvanceFee: cashAdvanceFee };
  if (typeof module !== "undefined") module.exports = api; else root.CardCalc = api;
})(this);
