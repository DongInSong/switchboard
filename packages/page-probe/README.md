# @switchboard/page-probe

페이지의 MAIN world에서 실행되어 DOM 요소의 소스 위치를 찾는다.

우선순위:
1. 빌드 마커: `data-tsd-source`, `data-v-inspector`, code-inspector-plugin 속성
2. 런타임: React fiber(`_debugSource` / React 19 `_debugStack` + 소스맵, bippy), Svelte `__svelte_meta.loc`, Vue `__vueParentComponent.type.__file`
3. 실패 시 빈 결과 → 데몬이 ripgrep 폴백

설계: [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) §5.2
