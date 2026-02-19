package ui

import (
	"github.com/getlantern/systray"
	"github.com/tasksquad/daemon/agent"
)

func RunSystray(agents []*agent.Agent, startAll, stopAll func()) {
	systray.Run(func() {
		systray.SetTitle("tsq")
		systray.SetTooltip("TaskSquad")

		mDash := systray.AddMenuItem("Open Dashboard", "")
		systray.AddSeparator()
		mStart := systray.AddMenuItem("Start All", "")
		mStop := systray.AddMenuItem("Stop All", "")
		systray.AddSeparator()
		mQuit := systray.AddMenuItem("Quit", "")

		go func() {
			for {
				select {
				case <-mDash.ClickedCh:
					OpenDashboard(agents)
				case <-mStart.ClickedCh:
					startAll()
				case <-mStop.ClickedCh:
					stopAll()
				case <-mQuit.ClickedCh:
					systray.Quit()
				}
			}
		}()
	}, func() {})
}
