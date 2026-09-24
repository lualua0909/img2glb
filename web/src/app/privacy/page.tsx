import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";
import { APP_NAME, OPERATOR_NAME } from "@/lib/config";
import { getLocale, getT } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT()).meta.privacy };
}

// TEMPLATE — have counsel review before launch.
function PrivacyEn() {
  return (
    <>
      <p>{OPERATOR_NAME} operates {APP_NAME}. This policy explains what we collect and why.</p>
      <h2>What we collect</h2>
      <p>
        Account data (name, email, hashed password or Google account id), images and prompts you submit, generated models,
        payment records (processed by Stripe — we never see card numbers), and basic logs (IP address, user agent) for security
        and rate limiting.
      </p>
      <h2>How we use it</h2>
      <p>
        To run the service, process payments, prevent abuse and support you. Inputs are sent to our GPU inference provider
        solely to generate your model. We do not sell your data or use your content to train models.
      </p>
      <h2>Retention</h2>
      <p>You can delete any model from your library at any time; deletion removes the stored input and output files.</p>
      <h2>Contact</h2>
      <p>Questions: contact {OPERATOR_NAME}.</p>
    </>
  );
}

function PrivacyVi() {
  return (
    <>
      <p>
        {OPERATOR_NAME} vận hành {APP_NAME}. Chính sách này giải thích chúng tôi thu thập những gì và vì sao. Bản tiếng Việt
        chỉ mang tính tham khảo; nếu có khác biệt, bản tiếng Anh được ưu tiên áp dụng.
      </p>
      <h2>Thông tin chúng tôi thu thập</h2>
      <p>
        Dữ liệu tài khoản (tên, email, mật khẩu đã được băm hoặc id tài khoản Google), hình ảnh và mô tả bạn gửi, các mô
        hình được tạo, hồ sơ thanh toán (do Stripe xử lý — chúng tôi không bao giờ thấy số thẻ) và nhật ký cơ bản (địa chỉ
        IP, user agent) phục vụ bảo mật và giới hạn tần suất truy cập.
      </p>
      <h2>Cách chúng tôi sử dụng</h2>
      <p>
        Để vận hành dịch vụ, xử lý thanh toán, ngăn chặn lạm dụng và hỗ trợ bạn. Dữ liệu đầu vào chỉ được gửi tới nhà cung
        cấp suy luận GPU của chúng tôi để tạo mô hình cho bạn. Chúng tôi không bán dữ liệu của bạn và không dùng nội dung
        của bạn để huấn luyện mô hình.
      </p>
      <h2>Lưu trữ</h2>
      <p>
        Bạn có thể xóa bất kỳ mô hình nào trong thư viện vào bất cứ lúc nào; khi xóa, file đầu vào và đầu ra đã lưu cũng bị
        gỡ bỏ.
      </p>
      <h2>Liên hệ</h2>
      <p>Mọi thắc mắc, vui lòng liên hệ {OPERATOR_NAME}.</p>
    </>
  );
}

export default async function PrivacyPage() {
  const [t, locale] = [await getT(), await getLocale()];
  return <LegalPage title={t.meta.privacy}>{locale === "vi" ? <PrivacyVi /> : <PrivacyEn />}</LegalPage>;
}
