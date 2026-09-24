import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";
import { APP_NAME, OPERATOR_NAME } from "@/lib/config";
import { getLocale, getT } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT()).meta.terms };
}

const license = (label: string) => <a href="/HUNYUAN3D_LICENSE.txt">{label}</a>;

// TEMPLATE — have counsel review before launch. Sections marked (required) implement obligations
// from the Tencent Hunyuan 3D 2.0 Community License (§3, §5) and must stay.
function TermsEn() {
  return (
    <>
      <p>
        These Terms govern your use of {APP_NAME}, operated by {OPERATOR_NAME} (&quot;we&quot;). By creating an account you agree to
        them.
      </p>
      <h2>1. The service</h2>
      <p>
        {APP_NAME} generates 3D models from images and text using Tencent Hunyuan 3D 2.0. Tencent is not affiliated with,
        associated with, sponsoring, or endorsing {APP_NAME}.
      </p>
      <h2>2. Territory (required)</h2>
      <p>
        The service and its outputs may not be used, reproduced, distributed or displayed in the European Union, the United
        Kingdom or South Korea.
      </p>
      <h2>3. Use restrictions (required)</h2>
      <p>
        Your use of the service and of any output must comply with applicable laws (including trade compliance laws) and with
        the Tencent Hunyuan 3D 2.0 Acceptable Use Policy (Exhibit A of the {license("license")}), which is incorporated into
        these Terms. You must not use the service, or any output or results of it, to improve any other AI model. These
        restrictions apply to anyone you distribute outputs to, and you must pass this notice on to them.
      </p>
      <h2>4. Your content</h2>
      <p>
        You must own or have rights to images you upload. You keep ownership of your inputs and, to the extent permitted by
        law, of the generated outputs. You grant us a limited license to process them to provide the service.
      </p>
      <h2>5. Credits & payments</h2>
      <p>
        Credits are prepaid, non-transferable and do not expire. Credits for failed generations are refunded automatically.
        Payments are processed by Stripe.
      </p>
      <h2>6. Disclaimers</h2>
      <p>
        Outputs are AI-generated and may be inaccurate. The service is provided &quot;as is&quot; without warranties, and our liability is
        limited to the amount you paid us in the 12 months before a claim.
      </p>
      <h2>7. Termination</h2>
      <p>We may suspend accounts that violate these Terms. You may delete your account at any time.</p>
    </>
  );
}

function TermsVi() {
  return (
    <>
      <p>
        Các Điều khoản này điều chỉnh việc bạn sử dụng {APP_NAME}, do {OPERATOR_NAME} (&quot;chúng tôi&quot;) vận hành. Khi tạo
        tài khoản, bạn đồng ý với các Điều khoản này. Bản tiếng Việt chỉ mang tính tham khảo; nếu có khác biệt, bản tiếng
        Anh được ưu tiên áp dụng.
      </p>
      <h2>1. Dịch vụ</h2>
      <p>
        {APP_NAME} tạo mô hình 3D từ hình ảnh và văn bản bằng Tencent Hunyuan 3D 2.0. Tencent không liên kết, không liên
        quan, không tài trợ và không xác nhận {APP_NAME}.
      </p>
      <h2>2. Phạm vi lãnh thổ (bắt buộc)</h2>
      <p>
        Dịch vụ và các kết quả đầu ra không được sử dụng, sao chép, phân phối hoặc hiển thị tại Liên minh Châu Âu, Vương
        quốc Anh hoặc Hàn Quốc.
      </p>
      <h2>3. Giới hạn sử dụng (bắt buộc)</h2>
      <p>
        Việc bạn sử dụng dịch vụ và mọi kết quả đầu ra phải tuân thủ pháp luật hiện hành (bao gồm luật tuân thủ thương mại)
        và Chính sách sử dụng được chấp nhận của Tencent Hunyuan 3D 2.0 (Phụ lục A của {license("giấy phép")}), là một phần
        của các Điều khoản này. Bạn không được dùng dịch vụ, hoặc bất kỳ kết quả đầu ra nào của dịch vụ, để cải thiện bất
        kỳ mô hình AI nào khác. Các giới hạn này áp dụng cho bất kỳ ai bạn phân phối kết quả đầu ra, và bạn phải chuyển
        thông báo này cho họ.
      </p>
      <h2>4. Nội dung của bạn</h2>
      <p>
        Bạn phải sở hữu hoặc có quyền đối với hình ảnh bạn tải lên. Bạn giữ quyền sở hữu dữ liệu đầu vào và, trong phạm vi
        pháp luật cho phép, cả kết quả được tạo ra. Bạn cấp cho chúng tôi quyền giới hạn để xử lý chúng nhằm cung cấp dịch
        vụ.
      </p>
      <h2>5. Credit & thanh toán</h2>
      <p>
        Credit được trả trước, không thể chuyển nhượng và không hết hạn. Credit của các lần tạo thất bại được hoàn lại tự
        động. Thanh toán được xử lý bởi Stripe.
      </p>
      <h2>6. Miễn trừ trách nhiệm</h2>
      <p>
        Kết quả do AI tạo ra và có thể không chính xác. Dịch vụ được cung cấp &quot;nguyên trạng&quot; không kèm bảo đảm, và trách
        nhiệm của chúng tôi giới hạn ở số tiền bạn đã thanh toán cho chúng tôi trong 12 tháng trước khi phát sinh khiếu nại.
      </p>
      <h2>7. Chấm dứt</h2>
      <p>Chúng tôi có thể tạm ngưng tài khoản vi phạm các Điều khoản này. Bạn có thể xóa tài khoản bất kỳ lúc nào.</p>
    </>
  );
}

export default async function TermsPage() {
  const [t, locale] = [await getT(), await getLocale()];
  return <LegalPage title={t.meta.terms}>{locale === "vi" ? <TermsVi /> : <TermsEn />}</LegalPage>;
}
