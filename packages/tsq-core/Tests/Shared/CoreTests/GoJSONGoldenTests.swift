import XCTest
@testable import TaskSquadCore

/// GoJSONValue is the writer for every JSON byte Go also writes, so it must
/// match encoding/json exactly — on macOS and on Linux, where JSONSerialization differs.
final class GoJSONGoldenTests: PlatformTestCase {
    /// Inputs exercising float formatting, escaping, key order, nesting and indent.
    private let corpus = [
        #"{"b":1,"a":[1.0,-0.0,0.5,100,1e20,1e21,123456789012345678,1.5e-7,0.000001,-2.5e-10,3.14159,1E3,9007199254740993]}"#,
        #"{"s":"<a href=\"x\">&amp;</a> / \\ \t\n\r \u0001 \u001f \u2028 \u2029    é 猫 😀","url":"http://localhost:1/hooks?a=1&b=2"}"#,
        #"{"nested":{"z":{},"y":[],"x":[{"k":null,"j":true,"i":false}]},"":"empty key","Z":"upper","a":"lower","é":"unicode key"}"#,
        #"[1,"two",null,[3,[4]]]"#,
        #"{"dup":1,"dup":2}"#,
        #"  {"ws" : [ 1 , 2 ] }  "#,
        #""bare string""#,
        #"-12.5e+2"#,
    ]

    func testFloatFormattingMatchesEncodingJSON() {
        let cases: [(Double, String)] = [
            (0, "0"), (-0.0, "-0"), (1, "1"), (-1, "-1"), (0.5, "0.5"), (100, "100"), (1e20, "100000000000000000000"),
            (1e21, "1e+21"), (1.5e300, "1.5e+300"), (1.5e-7, "1.5e-7"), (1e-6, "0.000001"), (2.5e-10, "2.5e-10"),
            (1e-100, "1e-100"), (123456789012345678, "123456789012345680"), (1700000000000, "1700000000000"),
            (3.14159, "3.14159"), (0.1, "0.1"), (5e-324, "5e-324"), (1.7976931348623157e308, "1.7976931348623157e+308"),
        ]
        for (value, expected) in cases { XCTAssertEqual(GoJSONValue.formatFloat(value), expected, "\(value)") }
    }

    func testEncodingMatchesGoWithoutOracle() throws {
        let value = try GoJSONValue.parse(Data(#"{"b":[1.0,"<&>"],"a":{}}"#.utf8), strict: true).float64
        XCTAssertEqual(value.marshal(), #"{"a":{},"b":[1,"\u003c\u0026\u003e"]}"#)
        XCTAssertEqual(value.marshal(indent: "  "), "{\n  \"a\": {},\n  \"b\": [\n    1,\n    \"\\u003c\\u0026\\u003e\"\n  ]\n}")
        XCTAssertEqual(value.encoded(indent: ""), value.marshal() + "\n")
        XCTAssertThrowsError(try GoJSONValue.parse(Data("{} x".utf8), strict: true))
        XCTAssertNoThrow(try GoJSONValue.parse(Data("{} x".utf8)))
        XCTAssertEqual(GoJSON.queryEscape("a b&c/é"), "a+b%26c%2F%C3%A9")
    }

    func testRoundTripMatchesGoOracle() throws {
        let oracle = try goOracle()
        for input in corpus {
            for indent in ["", "  ", "\t"] {
                let process = Process()
                process.executableURL = oracle
                process.arguments = ["json", indent]
                let stdin = Pipe(), stdout = Pipe()
                process.standardInput = stdin
                process.standardOutput = stdout
                try process.run()
                stdin.fileHandleForWriting.write(Data(input.utf8))
                try stdin.fileHandleForWriting.close()
                let go = String(decoding: stdout.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
                process.waitUntilExit()
                XCTAssertEqual(process.terminationStatus, 0, input)
                let swift = try GoJSONValue.parse(Data(input.utf8), strict: true).float64.marshal(indent: indent)
                XCTAssertEqual(swift, go, "indent \(indent.debugDescription): \(input)")
            }
        }
    }
}
