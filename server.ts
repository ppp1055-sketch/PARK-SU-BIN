import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());
  
  // API Route to validate Gemini API Key
  app.post("/api/validate-key", async (req, res) => {
    try {
      const { apiKey } = req.body;
      if (!apiKey || !apiKey.trim()) {
        return res.status(400).json({ success: false, error: "API Key is required." });
      }

      const ai = new GoogleGenAI({
        apiKey: apiKey.trim(),
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build-validator',
          }
        }
      });

      // Try a super simple, quick generation call to verify
      await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: "Validate API Key",
      });

      return res.json({ success: true });
    } catch (err: any) {
      console.error("API Key validation failure:", err);
      const errMsg = err.message || String(err);
      
      // Check if it's an API Key error (invalid key, active status, exhausted)
      let customError = "유효하지 않은 Key 입니다.";
      if (errMsg.includes("API key not valid") || errMsg.includes("invalid") || errMsg.includes("Key not found")) {
        customError = "유효하지 않은 Key 입니다.";
      } else if (errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.includes("429")) {
        customError = "유효하지만 한도가 초과되었거나 크레딧이 없는 Key 입니다.";
      }
      
      return res.status(400).json({ success: false, error: customError });
    }
  });

  // API Route to generate Job Match & Profile Report
  app.post("/api/generate-report", async (req, res) => {
    let isCustomKeyUsed = false;
    try {
      const {
        job,
        experienceType, // 'new' | 'experienced'
        experienceDetail,
        education,
        major,
        hasSkills, // 'yes' | 'no'
        skillsDetail,
        projects, // string[]
        projectDetails, // Record<string, string>
        apiKey,
      } = req.body;

      isCustomKeyUsed = !!(apiKey && apiKey.trim());
      const finalApiKey = apiKey?.trim() || process.env.GEMINI_API_KEY;

      if (!finalApiKey) {
        return res.status(500).json({ error: "GEMINI_API_KEY environment variable is not set and no custom API Key was provided." });
      }

      // Initialize Gemini Client
      const ai = new GoogleGenAI({
        apiKey: finalApiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });

      // 역량 충분/부족 판단 기준 (교육 추천 분기)
      // (a) 자격증·기술스택 "없음"
      // (b) 희망직무 핵심 스킬을 1개 이하 보유 (쉼표 구분)
      // (c) 프로젝트 경험 "해당 없음"
      const skillsList = skillsDetail ? skillsDetail.split(",").map((s: string) => s.trim()).filter(Boolean) : [];
      const isEduRecommended =
        hasSkills === "no" ||
        skillsList.length <= 1 ||
        (projects && projects.includes("해당 없음"));

      // 오늘 날짜 설정
      const todayDate = "2026년 6월 26일";

      // 쿼리 구성
      const expTerm = experienceType === "experienced" ? "경력" : "신입";
      const skillTerm = skillsList.length > 0 ? skillsList[0] : "";
      const searchQuery1 = `사람인 ${job} ${expTerm} ${skillTerm} 채용`;
      const searchQuery2 = `잡코리아 ${job} ${expTerm} ${skillTerm} 채용`;
      const searchQuery3 = `고용24 ${job} ${skillTerm} 공고`;

      const systemPrompt = `
너는 참여자의 프로필을 분석해, **검색 도구로 직접 조회·검증한 실제 채용공고만을** 매칭하는 AI 실시간 채용 매칭 전문가다. 너는 너의 기억(학습 데이터)에서 기업명·마감일·URL을 절대 인출하지 않으며, 오직 **이번 대화에서 검색 도구로 확인한 결과**만을 근거로 리포트를 작성한다.

# 핵심 원칙 (Absolute Rules — 다른 모든 지침에 우선)
0-1. **도구 사용 의무**: 채용공고를 출력하기 전, 반드시 웹 검색 도구를 호출해 실제 데이터를 조회한다. 검색 없이 공고를 작성하는 것은 금지다.
0-2. **환각 금지**: 검색 결과에서 직접 확인되지 않은 기업명·직무·마감일·URL은 한 글자도 생성하지 않는다. 추측·추론·"그럴듯한" 보완 모두 금지.
0-3. **검증 가능성 우선**: 정확하지만 적은 공고가, 많지만 불확실한 공고보다 항상 낫다. 확신이 없으면 그 항목을 빼거나 "확인 불가"로 표기한다.

# 작업 환경 설정 (리포트 생성 직전 1회 수행)
- 오늘 날짜는 **${todayDate}** 이다. 모든 "모집중/마감" 판단은 이 날짜를 기준으로 한다.

# 검색·검증 프로토콜 (공고 매칭 시 반드시 이 순서로 수행)
1. 참여자 희망직무·전공·스킬·경력·학력을 조합해 **플랫폼별 검색 쿼리**를 구성한다.
2. 각 플랫폼(사람인·잡코리아·고용24 등)에 대해 검색 도구를 호출한다(직무·플랫폼 조합당 1회 이상).
3. 검색 결과에서 **오늘 날짜(${todayDate}) 기준 접수 가능한 공고만** 선별한다.
4. 각 공고의 마감일과 상세 URL이 검색 결과에 명시되어 있는지 확인한다.
5. 확인된 정보만으로 표를 채운다. (아래 딥링크·마감일 정책 적용)

# 딥링크(URL) 정책 — 가장 엄격히 적용
- ✅ 검색 결과에 **실제로 노출된 상세페이지 URL**만 그대로 사용한다.
- ⚠️ 상세 URL을 확보하지 못한 경우: **rec_idx·게시글 ID 등을 절대 추측·조합하지 말고**, 대신 해당 플랫폼의 **검색어가 포함된 검색결과 페이지 URL**을 제공하고 링크 텍스트를 \`[검색결과 페이지(상세링크 미확인)]\`로 표기한다.
- ❌ ID를 임의로 만들어 상세 URL을 위조하는 행위는 0-2 위반으로 절대 금지.

# 마감일 정책
- 검색 결과에 명시된 마감일(예: ~7/13(월) 13시)은 그대로 반영한다.
- 마감일이 확인되지 않으면 임의 추정 없이 **"마감일 확인 불가"**로 표기한다.
- "상시채용/채용시 마감"으로 명시된 경우 그대로 표기한다.

# 역량 충분/부족 판단 기준 (교육 추천 분기)
- ${isEduRecommended ? "자격증·기술스택 없음, 희망직무 핵심 스킬 1개 이하 보유, 또는 프로젝트 없음 상태이므로 **공고 매칭 + 교육 추천 병행** 모드로 동작하십시오." : "실시간 공고 매칭을 기본으로 하십시오."}

# Output Format (출력 형식)
반드시 아래의 양식 마크다운을 유지하여 한국어로 답변을 생성하시오. 가짜 정보는 절대로 적지 말아야 하며, 실제로 검색에 성공한 공고만 넣으십시오.

### [실시간 채용공고 매칭 및 직무 진단 리포트]
> 🕒 조회 기준 시점: ${todayDate} / 출처: [검색한 채용플랫폼 이름 명시]
> ※ 채용 정보는 실시간으로 변동됩니다. 지원 전 반드시 원문 링크에서 최신 모집 여부와 마감일을 다시 확인하세요.

👤 **참여자 정보**
| 항목 | 내용 |
| :--- | :--- |
| 희망직무 | [입력값 그대로] |
| 경력 | [입력값 그대로] |
| 학력 | [입력값 그대로] |
| 전공 | [입력값 그대로] |
| 자격증·기술스택 | [입력값 그대로 / 또는 \"없음 — 교육 추천 병행\"] |
| 프로젝트 경험 | [선택 항목 + 각 상세, 또는 \"해당 없음\"] |

📊 **AI 직무진단**
- [스펙 기반 강점·보완점 진단 및 지원 방향성]
${isEduRecommended ? "- **🎓 추천 교육·훈련 과정**:\\n  (고용24 등에서 검색한 실제 국비지원, 부트캠프, 내일배움카드 과정 및 상세 바로가기 URL을 제공하십시오)\\n  - **[실제 교육 과정명]** ([플랫폼/기관]): [상세 내용 설명 및 일정] [교육 바로가기](실제URL 또는 검색URL)" : ""}

💼 **추천 채용공고**
| 기업 | 직무 | 마감 | 상태 | 적합도 | 바로가기 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| [실제기업명] | [실제직무] | [~0/00(요일) 00시 / 상시채용 / 마감일 확인 불가] | 🟢 모집중 | ⭐⭐⭐⭐⭐ | [공고 바로가기](상세 URL) 또는 [검색결과 페이지(상세링크 미확인)](검색페이지 URL) |

*(참고: 검색 결과 조건에 맞는 모집중 공고가 0건이면 빈 표를 채우지 말고 \"현재 조건의 활성 공고를 확인하지 못했다\"고 명확하게 명시하고, 검색어 확장·인접 직무·교육과정을 대안으로 제시하십시오. 절대 가짜 데이터로 표를 채우지 마십시오)*

📌 **AI 추천 이유**
- **[핵심 기업명]**
  - ✔ [공고 요구사항 ↔ 참여자 프로필 실제 매칭 근거]
  - ✔ [일치하는 자격증·기술스택·프로젝트 명시]

🚨 **지원 우선순위** (마감 임박 + 적합도 종합)
① [기업명] ([마감일])
② [기업명] ([마감일])
`;

      const userPrompt = `
참여자가 제공한 프로필 정보를 토대로, 아래 검색 쿼리를 바탕으로 구글 실시간 검색을 수행해 실제 구인 공고를 수집한 뒤 엄격한 검증을 거쳐 보고서를 작성해 주세요.

**추천 검색 쿼리**:
1. "${searchQuery1}"
2. "${searchQuery2}"
3. "${searchQuery3}"

**참여자 프로필**:
- 희망직무: ${job}
- 경력상태: ${experienceType === "experienced" ? `경력 있음 (${experienceDetail})` : "신입(경력 없음)"}
- 학력: ${education}
- 전공 계열: ${major}
- 자격증 및 기술 스택: ${hasSkills === "yes" ? skillsDetail : "없음"}
- 프로젝트 경험: ${projects && projects.length > 0 ? projects.join(", ") : "해당 없음"}
${
  projectDetails
    ? Object.entries(projectDetails)
        .map(([proj, desc]) => `  - [${proj} 상세]: ${desc}`)
        .join("\n")
    : ""
}

**안내**:
- 검색 도구를 적극 활용하여 실제 2026년 6월 현재 살아있는 채용 정보를 검색하십시오.
- 마감되었거나 유효하지 않은 공고는 절대 적지 마십시오.
- 딥링크 URL이 없다면, \`[검색결과 페이지(상세링크 미확인)](해당 검색 URL)\`로 설정하십시오. ID를 추측하여 임의의 가짜 상세 URL을 생성하지 마십시오.
- 마감일을 알 수 없다면 "마감일 확인 불가"로 명시하십시오.
`;

      let response;
      let lastError: any = null;
      const modelsToTry = ["gemini-3.5-flash", "gemini-flash-latest", "gemini-3.1-flash-lite"];

      for (const modelName of modelsToTry) {
        try {
          console.log(`[API] Attempting report generation with model: ${modelName}`);
          const resObj = await ai.models.generateContent({
            model: modelName,
            contents: userPrompt,
            config: {
              systemInstruction: systemPrompt,
              tools: [{ googleSearch: {} }],
            },
          });
          if (resObj && resObj.text) {
            response = resObj;
            console.log(`[API] Successfully generated report using model: ${modelName}`);
            break;
          }
        } catch (error: any) {
          console.error(`[API] Failed with model ${modelName}:`, error.message || error);
          lastError = error;
        }
      }

      if (!response && lastError) {
        throw lastError;
      }

      const reportMarkdown = response?.text || "리포트를 생성하는 데 실패했습니다. 다시 시도해 주세요.";
      res.json({ reportMarkdown });
    } catch (err: any) {
      console.error("Error generating report:", err);
      
      const errString = err.message || String(err);
      const isQuotaExceeded = 
        errString.includes("RESOURCE_EXHAUSTED") || 
        errString.includes("quota") || 
        errString.includes("429") ||
        (err.status && err.status === 429);

      if (isQuotaExceeded) {
        if (isCustomKeyUsed) {
          return res.status(429).json({
            error: "⚠️ 입력하신 [개인 API Key]의 요청 한도 또는 크레딧이 소진되었습니다.\n\n" +
                   "입력하신 Gemini API 키가 정상적으로 백엔드에 적용되었으나, 해당 키의 무료 크레딧이 만료되었거나 결제 한도(Prepayment Credits Depleted)에 도달해 구글 API 호출이 거부되었습니다.\n\n" +
                   "해결 방법:\n" +
                   "1. 구글 AI 스튜디오(https://aistudio.google.com/)에서 결제(Billing) 상태 및 남은 크레딧을 확인해 주세요.\n" +
                   "2. 또는 다른 유효한 구글 계정으로 새 API Key를 발급받아 등록해 보세요.\n" +
                   "3. 키를 완전히 삭제하고 잠시 후 공용 키로 재시도하실 수도 있습니다."
          });
        } else {
          return res.status(429).json({
            error: "⚠️ 공용 API 요청 한도가 모두 소진되었습니다 (RESOURCE_EXHAUSTED).\n\n" +
                   "현재 동시 사용자가 많아 공유 계정의 무료 제공량 한도에 도달했습니다.\n\n" +
                   "해결 방법:\n" +
                   "1. 우측 상단의 [개인 API 키] 버튼을 눌러 본인의 Gemini API Key를 입력하시면 즉시 한도 제한 없이 초고속으로 작동합니다.\n" +
                   "2. 약 1~2분 뒤에 '다시 시작하기'를 눌러 재요청해 보세요."
          });
        }
      }

      res.status(500).json({ error: errString || "리포트를 생성하는 중 오류가 발생했습니다." });
    }
  });

  // Serve static assets or mount Vite dev middleware
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

startServer();
