# wtcat

WebTransport cat.

## Usage

```text
Usage: wtcat [options] <url>

WebTransport Cat — like wscat but for WebTransport.

Arguments:
  url                          WebTransport server URL

Options:
  -V, --version                output the version number
  --no-color                   run without color
  --stream-type <type>         stream type: "bidi" (default) or "send" (default: "bidi")
  --datagram                   use datagrams instead of streams (unreliable, unordered)
  --ca <ca>                    path to CA certificate file (PEM)
  --connect-timeout <seconds>  connection timeout in seconds (default: "15")
  --strict-tls                 require pinned certificate hash via --ca unless --insecure is set
  --insecure                   do not verify the server TLS certificate (insecure)
  --auth <username:password>   add HTTP Basic Authorization header
  -H, --header <header:value>  set an HTTP header (repeatable) (default: [])
  -x, --execute <command>      send message after connecting, then exit (repeatable) (default: [])
  -w, --wait <seconds>         seconds to wait after --execute before closing (-1 to hold open)
  -P, --show-datagrams         print notice for each incoming datagram (with --datagram)
  -h, --help                   display help for command
```

## Examples

```bash
wtcat https://wt-ord.akaleapi.net:6161/echo
wtcat https://wt-ord.akaleapi.net:6161/echo -x "hello" --wait 2
wtcat https://wt-ord.akaleapi.net:6161/echo --datagram -x "ping" --wait 2
```
