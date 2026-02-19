package ui

import (
	"encoding/json"
	"fmt"

	webview "github.com/webview/webview_go"
	"github.com/tasksquad/daemon/agent"
)

const dashHTML = `<!DOCTYPE html>
<html>
<head><title>TaskSquad</title>
<style>body{font-family:system-ui;padding:20px;background:#fafafa}
h1{font-size:18px;margin-bottom:16px}
.agent{background:#fff;border:1px solid #eee;border-radius:8px;padding:12px 16px;margin-bottom:8px;display:flex;justify-content:space-between}
.status{font-size:12px;padding:2px 8px;border-radius:10px;background:#eee}
.idle{background:#d1fae5;color:#065f46}
.accumulating,.live{background:#dbeafe;color:#1e40af}
.waiting_input{background:#fef3c7;color:#92400e}
</style></head>
<body>
<h1>TaskSquad Agents</h1>
<div id="agents"></div>
<script>
function refresh(){window.getAgents().then(a=>{
document.getElementById('agents').innerHTML=a.map(x=>
'<div class="agent"><div><b>'+x.Name+'</b><br><small>'+x.Config.Command+'</small></div><span class="status '+x.ModeStr+'">'+x.ModeStr+'</span></div>'
).join('')})}
refresh(); setInterval(refresh,5000)
</script>
</body></html>`

type agentInfo struct {
	Name    string
	ModeStr string
	Config  struct {
		Command string
		WorkDir string
	}
}

func OpenDashboard(agents []*agent.Agent) {
	w := webview.New(false)
	defer w.Destroy()
	w.SetTitle("TaskSquad")
	w.SetSize(480, 400, webview.HintNone)

	w.Bind("getAgents", func() []agentInfo {
		var list []agentInfo
		for _, a := range agents {
			info := agentInfo{
				Name:    a.Config.Name,
				ModeStr: fmt.Sprintf("%s", a.Mode),
			}
			info.Config.Command = a.Config.Command
			info.Config.WorkDir = a.Config.WorkDir
			list = append(list, info)
		}
		return list
	})

	_ = json.Marshal // keep import
	w.SetHtml(dashHTML)
	w.Run()
}
