package provider

// OpenCode is the provider for sst/opencode CLI.
//
// TODO: Implement OpenCode hook support.
//
// OpenCode supports session hooks via opencode.json at the project root.
// Expected config format (verify against opencode docs):
//
//	{
//	  "hooks": {
//	    "session:complete": "curl -s -X POST http://localhost:{port}/hooks/stop -H 'Content-Type: application/json' -d @-",
//	    "notification":     "curl -s -X POST http://localhost:{port}/hooks/notification -H 'Content-Type: application/json' -d @-"
//	  }
//	}
//
// Once implemented:
//   - Setup() writes opencode.json with the hooks above
//   - UsesHooks() returns true
//   - hooks/server.go may need a /hooks/opencode/* path if event shapes differ

type OpenCode struct{}

func (p *OpenCode) Name() string { return "opencode" }

// TODO: return true once hook setup is verified against opencode's hook format.
func (p *OpenCode) UsesHooks() bool { return false }

func (p *OpenCode) Env(_ int) []string { return nil }

// TODO: Write opencode.json with session hooks pointing to hooksPort.
func (p *OpenCode) Setup(_ string, _ int) error { return nil }
