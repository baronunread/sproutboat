export default {
  fetch() {
    // A timezone offset must move the instant. Porffor alpha-4 ignores the
    // offset and, with no fractional part to occupy them, folds its digits into
    // milliseconds: "+02:00" lands as ".002Z" (#90).
    return Response.json({
      utc: new Date("2024-01-02T03:04:05Z").toISOString(),
      plus: new Date("2024-01-02T03:04:05+02:00").toISOString(),
      minus: new Date("2024-01-02T03:04:05-05:00").toISOString(),
      millis: new Date("2024-01-02T03:04:05.250+01:00").toISOString(),
    });
  },
};
