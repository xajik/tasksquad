// The C library (and Foundation's networking module) for the OS being built. The
// only per-OS branch allowed in TaskSquadCore: every call through it has the same meaning.
#if canImport(Darwin)
@_exported import Darwin
#elseif canImport(Glibc)
@_exported import Glibc
#elseif canImport(Musl)
@_exported import Musl
#endif
// URLRequest/URLSession live in FoundationNetworking outside Apple platforms.
#if canImport(FoundationNetworking)
@_exported import FoundationNetworking
#endif

/// POSIX read/write/open, for code inside types that shadow those names.
func posixRead(_ fd: Int32, _ buffer: UnsafeMutableRawPointer?, _ count: Int) -> Int { read(fd, buffer, count) }
func posixWrite(_ fd: Int32, _ buffer: UnsafeRawPointer?, _ count: Int) -> Int { write(fd, buffer, count) }
func posixOpen(_ path: String, _ flags: Int32) -> Int32 { open(path, flags) }
