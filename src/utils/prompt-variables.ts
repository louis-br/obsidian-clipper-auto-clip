import { PromptVariable, Template } from '../types/types';

const promptRegex = /{{(?:prompt:)?"([\s\S]*?)"(\|.*?)?}}/g;

export function collectTemplatePromptVariables(template: Template | null): PromptVariable[] {
	const promptMap = new Map<string, PromptVariable>();

	function addPrompt(prompt: string, filters: string) {
		if (!promptMap.has(prompt)) {
			const key = `prompt_${promptMap.size + 1}`;
			promptMap.set(prompt, { key, prompt, filters });
		}
	}

	function scan(value: string | undefined) {
		if (!value) return;
		promptRegex.lastIndex = 0;
		let match;
		while ((match = promptRegex.exec(value)) !== null) {
			addPrompt(match[1], match[2] || '');
		}
	}

	scan(template?.noteNameFormat);
	scan(template?.path);
	scan(template?.noteContentFormat);
	scan(template?.context);

	if (template?.properties) {
		for (const property of template.properties) {
			scan(property.value);
		}
	}

	return Array.from(promptMap.values());
}
