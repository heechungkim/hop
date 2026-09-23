import { toolCommands as upstreamToolCommands } from '@/upstream/commands';
import type { CommandDef } from '@/upstream/commands';
import { OptionsDialog } from '@/ui/options-dialog';
import { replaceUpstreamCommands } from '../replace-upstream-commands';

/**
 * upstream의 tool:options는 상대 경로(`../../ui/options-dialog`)로 OptionsDialog를 직접
 * import하기 때문에, HOP이 `ui/options-dialog`를 포크해도 그 alias를 타지 않는다. 이 커맨드만
 * `@/ui/options-dialog`(HOP 포크)로 다시 연결한다 (golbin/hop#98 후속 요청).
 */
const toolOptions: CommandDef = {
  id: 'tool:options',
  label: '환경 설정',
  execute(services) {
    const dlg = new OptionsDialog(services.eventBus);
    dlg.show();
  },
};

export const toolCommands: CommandDef[] = replaceUpstreamCommands(upstreamToolCommands, [toolOptions]);
