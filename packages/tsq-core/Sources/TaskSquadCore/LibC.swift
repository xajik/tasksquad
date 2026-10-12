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

/// POSIX open, for code inside types that shadow the name.
func posixOpen(_ path: String, _ flags: Int32) -> Int32 { open(path, flags) }
