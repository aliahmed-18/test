import { Navigate, Route, Routes } from 'react-router-dom'
import { HomePage } from './pages/HomePage'
import { HostDashboardPage } from './pages/HostDashboardPage'
import { StudentJoinPage } from './pages/StudentJoinPage'
import { StudentAskPage } from './pages/StudentAskPage'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/host/:code" element={<HostDashboardPage />} />
      <Route path="/join" element={<StudentJoinPage />} />
      <Route path="/join/:code" element={<StudentAskPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
