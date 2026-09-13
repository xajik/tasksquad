package provider

import "regexp"

var tsqSkillInvocation = regexp.MustCompile(`(^|[\s])/(tsq-[A-Za-z0-9_-]+)\b`)

func codexSkillPrompt(prompt string) string {
	return tsqSkillInvocation.ReplaceAllString(prompt, "${1}$$${2}")
}

// FormatPrompt adapts portable TaskSquad skill references for a harness.
func FormatPrompt(p Provider, prompt string) string {
	if formatter, ok := p.(interface{ FormatPrompt(string) string }); ok {
		return formatter.FormatPrompt(prompt)
	}
	return prompt
}
