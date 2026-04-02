package cmd

import (
	authcmd "github.com/tasksquad/daemon/cmd/auth"
	hookscmd "github.com/tasksquad/daemon/cmd/hooks"
	logscmd "github.com/tasksquad/daemon/cmd/logs"
	tmuxcmd "github.com/tasksquad/daemon/cmd/tmux"
)

func RunInit()                { authcmd.RunInit() }
func RunLogin()               { authcmd.RunLogin() }
func RunLogout()              { authcmd.RunLogout() }
func RunSessions()            { tmuxcmd.RunSessions() }
func RunAttach(args []string) { tmuxcmd.RunAttach(args) }
func RunLogs(args []string)   { logscmd.RunLogs(args) }
func RunPane(args []string)   { tmuxcmd.RunPane(args) }
func RunSend(args []string)   { tmuxcmd.RunSend(args) }
func RunReport(args []string) { hookscmd.RunReport(args) }
func RunSkill(args []string)  { hookscmd.RunSkill(args) }
