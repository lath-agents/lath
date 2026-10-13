//! The air gap's acceptance probe.
//!
//! A stand-in for the `zeroclaw` binary: the host starts it under exactly the wrapper it starts
//! `zeroclaw` under, and it tries every reach the wrapper must deny, plus the few it must allow.
//! It is std-only, so what it can do is what any Rust binary with the same syscalls can do; a
//! wrapper that stops it stops a ZeroClaw bug or a replaced binary the same way.
//!
//! Each attempt prints one line, `<name>\t<reached|denied>\t<detail>`. The harness decides which
//! outcome each name must have; the probe never judges itself, so a probe that is itself wrong
//! cannot report a pass.
//!
//! Arguments are `name=value` pairs, all optional, so the harness names every target explicitly
//! and nothing is read from the environment the wrapper was told to scrub:
//!   tcp=<ip:port>        outbound TCP to an address outside the host (no DNS)
//!   loopback=<ip:port>   outbound TCP to a listener the harness opened on the host's loopback
//!   udp=<ip:port>        a UDP datagram out
//!   dns=<host:port>      a name lookup
//!   read=<path>          a file read (repeatable)
//!   write=<path>         a file create-and-write (repeatable)
//!   unix=<path>          a Unix-socket connect that must be denied (repeatable)
//!   allow=<path>         a Unix-socket connect that must be allowed; sends `ping\n` and reads
//!                        one line back (repeatable)
//!   exec=<path>          a child process (repeatable)
//!   env=1                prints the names of every variable the process was started with

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs, UdpSocket};
use std::os::unix::net::UnixStream;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(3);

fn report(name: &str, target: &str, outcome: Result<String, String>) {
    match outcome {
        Ok(detail) => println!("{name}:{target}\treached\t{detail}"),
        Err(detail) => println!("{name}:{target}\tdenied\t{detail}"),
    }
}

fn tcp(target: &str) -> Result<String, String> {
    let addr: SocketAddr = target.parse().map_err(|e| format!("bad address: {e}"))?;
    TcpStream::connect_timeout(&addr, TIMEOUT)
        .map(|_| "connected".into())
        .map_err(|e| e.to_string())
}

fn udp(target: &str) -> Result<String, String> {
    let sock = UdpSocket::bind("0.0.0.0:0").map_err(|e| format!("bind: {e}"))?;
    sock.send_to(b"lath-airgap-probe", target)
        .map(|n| format!("sent {n} bytes"))
        .map_err(|e| e.to_string())
}

fn dns(target: &str) -> Result<String, String> {
    match target.to_socket_addrs() {
        Ok(mut addrs) => match addrs.next() {
            Some(a) => Ok(format!("resolved {a}")),
            None => Err("no addresses".into()),
        },
        Err(e) => Err(e.to_string()),
    }
}

fn read(path: &str) -> Result<String, String> {
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(format!("{} bytes", buf.len()))
}

fn write(path: &str) -> Result<String, String> {
    let mut f = std::fs::File::create(path).map_err(|e| e.to_string())?;
    f.write_all(b"lath-airgap-probe\n").map_err(|e| e.to_string())?;
    Ok("written".into())
}

fn unix(path: &str) -> Result<String, String> {
    let mut s = UnixStream::connect(path).map_err(|e| e.to_string())?;
    s.set_read_timeout(Some(TIMEOUT)).ok();
    s.write_all(b"ping\n").map_err(|e| format!("connected, write: {e}"))?;
    let mut line = String::new();
    BufReader::new(s)
        .read_line(&mut line)
        .map_err(|e| format!("connected, read: {e}"))?;
    Ok(format!("answered {:?}", line.trim_end()))
}

fn exec(path: &str) -> Result<String, String> {
    std::process::Command::new(path)
        .env_clear()
        .output()
        .map(|o| format!("exited {:?}", o.status.code()))
        .map_err(|e| e.to_string())
}

fn main() {
    for arg in std::env::args().skip(1) {
        let Some((name, target)) = arg.split_once('=') else {
            eprintln!("ignoring {arg:?}: expected name=value");
            continue;
        };
        let outcome = match name {
            "tcp" | "loopback" => tcp(target),
            "udp" => udp(target),
            "dns" => dns(target),
            "read" => read(target),
            "write" => write(target),
            "unix" | "allow" => unix(target),
            "exec" => exec(target),
            "env" => {
                let mut names: Vec<String> = std::env::vars_os()
                    .map(|(k, _)| k.to_string_lossy().into_owned())
                    .collect();
                names.sort();
                Ok(names.join(","))
            }
            _ => {
                eprintln!("ignoring unknown probe {name:?}");
                continue;
            }
        };
        report(name, target, outcome);
    }
}
