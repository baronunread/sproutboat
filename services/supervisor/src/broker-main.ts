import { startBroker } from "@sproutboat/wire/broker";

/**
 * Entry point the supervisor runs for each deployment's broker.
 *
 * It is `@sproutboat/wire`'s own broker, started with the same argv. The only
 * addition is how dispatch (cron, queue, alarm work) is switched on for a staged
 * candidate. The broker used to be signalled with SIGUSR1/SIGUSR2, which cannot
 * cross the sandbox: the signal would reach bubblewrap, not the broker inside
 * its pid namespace. Here the supervisor writes `enable` or `disable` lines to
 * the broker's stdin instead. The signals still work for a broker run by hand.
 */
const session = startBroker(process.argv.slice(2));
process.on("SIGUSR1", session.enableDispatch);
process.on("SIGUSR2", session.disableDispatch);
console.log(`sproutboat broker: 127.0.0.1:${session.port}`);

void (async () => {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of Bun.stdin.stream()) {
    pending += decoder.decode(chunk, { stream: true });
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const command = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (command === "enable") session.enableDispatch();
      else if (command === "disable") session.disableDispatch();
      newline = pending.indexOf("\n");
    }
  }
})();
