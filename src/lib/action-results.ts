export type ActionFailure<Code extends string = string> = {
  ok: false;
  code: Code;
  message: string;
};

export function actionFailure<Code extends string>(
  code: Code,
  message: string
): ActionFailure<Code> {
  return { ok: false, code, message };
}
