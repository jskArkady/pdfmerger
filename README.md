# PDF 병합기

브라우저에서 여러 PDF 파일을 하나로 합치는 단일 페이지 앱입니다. 별도 서버나 외부 라이브러리 없이 `index.html`과 `src/pdf-merger.js`만으로 동작합니다.

## 사용 방법

1. `index.html`을 브라우저에서 엽니다.
2. PDF 파일을 선택하거나 화면에 끌어다 놓습니다.
3. 병합할 순서를 조정합니다.
4. `PDF 병합` 버튼을 누릅니다.
5. 저장 위치를 선택하거나, 브라우저 다운로드로 `merged.pdf`를 받습니다.

로컬 서버로 실행하려면 프로젝트 루트에서 다음 명령을 사용할 수 있습니다.

```sh
python3 -m http.server 8000
```

이후 브라우저에서 `http://localhost:8000`을 엽니다.

## 기능

- 여러 PDF 파일 선택
- 드래그 앤 드롭으로 파일 추가
- 파일별 페이지 수 표시
- 드래그, 위/아래 버튼으로 병합 순서 변경
- 파일명, 파일 크기, 페이지 수, 추가순 정렬
- 브라우저 안에서 병합 PDF 생성
- File System Access API 지원 브라우저에서는 저장 위치 선택
- 그 외 브라우저에서는 `merged.pdf` 자동 다운로드

## 제한 사항

이 프로젝트는 PDF 병합을 직접 구현한 경량 도구입니다. 완전한 PDF 편집 엔진은 아닙니다.

지원하지 않는 PDF:

- 암호화되었거나 비밀번호가 필요한 PDF
- `/FlateDecode` 외 다른 필터로 압축된 object stream PDF
- 스트림 `/Length`가 간접 참조이고, 해당 길이 객체를 일반 xref 테이블에서 찾을 수 없는 PDF (xref stream만 사용하는 경우 등)
- 객체 구조가 손상된 PDF

스트림 데이터는 `/Length`에 지정된 바이트 수를 기준으로 보존합니다. 직접 지정된 길이와 일반 xref 테이블로 찾을 수 있는 간접 길이 객체를 지원하며, 증분 저장의 `/Prev` 연결도 확인합니다. 길이를 확인할 수 없거나 종료 표식과 일치하지 않으면 병합을 중단합니다.

파일 크기가 크거나 파일 수가 많으면 브라우저 메모리 사용량이 커질 수 있습니다.

## 파일 구조

```text
.
├── index.html
├── src/
│   └── pdf-merger.js
└── tests/
    └── test-pdf-merger.cjs
```

## 테스트

Node.js가 설치되어 있으면 병합 로직 테스트를 실행할 수 있습니다.

```sh
node tests/test-pdf-merger.cjs
```

문법 검사는 다음 명령을 사용합니다.

```sh
node --check src/pdf-merger.js
node --check tests/test-pdf-merger.cjs
```
