// TCP relay: listen on PORT, forward each connection to HOST:PORT2. Used for ReplicaGate at 15.0.0.2:80,
// whose backend runs in the fake gate process (shared state with ControlGate).
// usage: node relay.mjs <listenPort> <host:port>
import net from "node:net";

const [listen, target] = process.argv.slice(2);
const [host, port] = target.split(":");
net
  .createServer((c) => {
    const u = net.connect(Number(port), host);
    c.pipe(u).pipe(c);
    const end = () => {
      c.destroy();
      u.destroy();
    };
    c.on("error", end);
    u.on("error", end);
  })
  .listen(Number(listen), "0.0.0.0", () => console.log(JSON.stringify({ ev: "relay", listen, target })));
