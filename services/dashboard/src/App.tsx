import { createBrowserRouter, Navigate } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { LoginPage } from './pages/LoginPage';

// 13a: only the login screen exists. The other routes, the guards and the session come with the next sub-steps.
const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '*', element: <Navigate to="/login" replace /> },
]);

export function App() {
  return <RouterProvider router={router} />;
}
