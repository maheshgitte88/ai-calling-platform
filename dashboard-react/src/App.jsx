import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import InterviewCandidate from "./pages/InterviewCandidate";
import Interviews from "./pages/Interviews";
import InterviewJoin from "./pages/InterviewJoin";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Match with or without trailing slash (links and probes may use /interview/join/). */}
        <Route path="/interview/join" element={<InterviewJoin />} />
        <Route path="/interview/join/" element={<InterviewJoin />} />
        <Route
          path="*"
          element={
            <Layout>
              <Routes>
                <Route path="/" element={<Navigate to="/interviews" replace />} />
                <Route path="/interviews" element={<Interviews />} />
                <Route
                  path="/interview-candidate"
                  element={<InterviewCandidate />}
                />
                <Route path="*" element={<Navigate to="/interviews" replace />} />
              </Routes>
            </Layout>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
