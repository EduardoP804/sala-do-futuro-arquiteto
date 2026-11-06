import { readFile } from 'node:fs/promises';

const queryFile = new URL('./khan-graphql.json', import.meta.url);
let queries;

async function getQueries() {
  return queries ||= JSON.parse(await readFile(queryFile, 'utf8'));
}

export async function graphQL(tab, operationName, variables) {
  if (new URL(tab.url()).origin !== 'https://pt.khanacademy.org') throw new Error('A sessão Khan saiu da origem autorizada.');
  const query = (await getQueries())[operationName];
  if (!query) throw new Error(`Operação Khan indisponível: ${operationName}`);
  const result = await tab.evaluate(async ({ operationName, query, variables }) => {
    const response = await fetch(`/api/internal/graphql/${operationName}?lang=pt&app=khanacademy`, {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-ka-fkey': '1' },
      body: JSON.stringify({ operationName, variables, query })
    });
    return { status: response.status, data: await response.json().catch(() => null) };
  }, { operationName, query, variables });
  if (result.status !== 200 || result.data?.errors?.length) {
    throw new Error(`Khan ${operationName}: HTTP ${result.status}, ${result.data?.errors?.[0]?.message || 'resposta inválida'}`);
  }
  return result.data?.data;
}

export function nextReservedItem(task) {
  const completed = new Set(task?.reservedItemsCompleted || []);
  return (task?.reservedItems || []).find(value => !completed.has(value))?.split('|').at(-1) || null;
}

export function presentQuestion(item) {
  const data = JSON.parse(item.itemDataAnswerless || '{}');
  const widgets = data.question?.widgets || {};
  const choices = Object.entries(widgets).flatMap(([name, widget]) => widget.type === 'radio' ? [{
    widget: name, multiple_select: !!widget.options?.multipleSelect,
    options: (widget.options?.choices || []).map(choice => ({ id: choice.id, text: choice.content }))
  }] : []);
  return { assessment_item_id: item.id, problem_type: item.problemType, text: data.question?.content || '', choices, widget_types: [...new Set(Object.values(widgets).map(widget => widget.type))] };
}

export function radioAttemptInput({ task, practiceVariables, item, choiceId }) {
  if (!task?.key || !task?.contentKey || !practiceVariables?.input?.exerciseId || !practiceVariables?.ancestorIds?.[0]) throw new Error('Dados da prática Khan incompletos.');
  const currentId = nextReservedItem(task);
  if (!currentId || currentId !== item.id) throw new Error('A questão mudou; atualize a leitura antes de responder.');
  const data = JSON.parse(item.itemDataAnswerless || '{}');
  const radios = Object.entries(data.question?.widgets || {}).filter(([, widget]) => widget.type === 'radio');
  if (radios.length !== 1 || radios[0][1].options?.multipleSelect) throw new Error('Formato de resposta ainda não validado para envio direto.');
  const [widgetName, widget] = radios[0];
  const options = widget.options || {};
  if (!(options.choices || []).some(choice => choice.id === choiceId)) throw new Error('Alternativa não pertence à questão atual.');
  const choices = options.choices.map((choice, index) => ({ content: choice.content, id: choice.id, originalIndex: index, correct: false }));
  const choiceStates = choices.map(choice => ({ selected: choice.id === choiceId, highlighted: false, readOnly: false, rationaleShown: false, correctnessShown: false, previouslyAnswered: false }));
  return {
    problemNumber: null, assessmentItemSha: item.sha, assessmentItemId: item.id,
    exerciseId: practiceVariables.input.exerciseId,
    closestCurationNodeId: practiceVariables.ancestorIds[0],
    problemType: item.problemType, countHints: 0, timeTaken: 10, attemptNumber: 1,
    attemptContent: JSON.stringify([{ selectedChoiceIds: [choiceId] }]),
    attemptState: JSON.stringify({ [widgetName]: {
      choices, hasNoneOfTheAbove: !!options.hasNoneOfTheAbove, countChoices: !!options.countChoices,
      multipleSelect: false, deselectEnabled: !!options.deselectEnabled,
      alignment: widget.alignment || 'default', numCorrect: 0, choiceStates
    } }),
    taskContentKey: task.contentKey, taskKey: task.key, skipped: false,
    localTimezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60, gaReferrer: '',
    userInput: JSON.stringify({ [widgetName]: { selectedChoiceIds: [choiceId] } })
  };
}

export function numericAttemptInput({ task, practiceVariables, item, value }) {
  if (!task?.key || !task?.contentKey || !practiceVariables?.input?.exerciseId || !practiceVariables?.ancestorIds?.[0]) throw new Error('Dados da prática Khan incompletos.');
  if (nextReservedItem(task) !== item.id) throw new Error('A questão mudou; atualize a leitura antes de responder.');
  if (typeof value !== 'string' || !value.trim() || value.length > 120) throw new Error('Resposta numérica vazia ou longa demais.');
  const data = JSON.parse(item.itemDataAnswerless || '{}');
  const widgets = Object.entries(data.question?.widgets || {});
  if (widgets.length !== 1 || widgets[0][1].type !== 'numeric-input') throw new Error('Formato numérico ainda não validado para envio direto.');
  const [widgetName, widget] = widgets[0];
  const options = widget.options || {};
  return {
    problemNumber: null, assessmentItemSha: item.sha, assessmentItemId: item.id,
    exerciseId: practiceVariables.input.exerciseId,
    closestCurationNodeId: practiceVariables.ancestorIds[0],
    problemType: item.problemType, countHints: 0, timeTaken: 10, attemptNumber: 1,
    attemptContent: JSON.stringify([{ currentValue: value }]),
    attemptState: JSON.stringify({ [widgetName]: {
      size: options.size || 'normal', coefficient: !!options.coefficient,
      textAlign: options.textAlign || 'left', alignment: widget.alignment || 'default',
      static: !!widget.static, answerForms: [], labelText: options.labelText || '', currentValue: value
    } }),
    taskContentKey: task.contentKey, taskKey: task.key, skipped: false,
    localTimezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60, gaReferrer: '',
    userInput: JSON.stringify({ [widgetName]: { currentValue: value } })
  };
}
