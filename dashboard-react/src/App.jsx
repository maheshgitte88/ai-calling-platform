import { BrowserRouter, Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import Clients from "./pages/Clients";
import ClientConfig from "./pages/ClientConfig";
import Calls from "./pages/Calls";
import Campaigns from "./pages/Campaigns";
import Playground from "./pages/Playground";
import InterviewCandidate from "./pages/InterviewCandidate";
import Interviews from "./pages/Interviews";
import InterviewJoin from "./pages/InterviewJoin";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/interview/join" element={<InterviewJoin />} />
        <Route
          path="*"
          element={(
            <Layout>
              <Routes>
                <Route path="/" element={<Clients />} />
                <Route path="/clients" element={<Clients />} />
                <Route path="/clients/:clientId/config" element={<ClientConfig />} />
                <Route path="/calls" element={<Calls />} />
                <Route path="/campaigns" element={<Campaigns />} />
                <Route path="/interviews" element={<Interviews />} />
                <Route path="/playground" element={<Playground />} />
                <Route path="/interview-candidate" element={<InterviewCandidate />} />
              </Routes>
            </Layout>
          )}
        />
      </Routes>
    </BrowserRouter>
  );
}
