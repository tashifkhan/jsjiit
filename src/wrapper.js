import { NotLoggedIn, SessionExpired, SessionError, AccountAPIError, LoginError, APIError } from "./exceptions.js";
import { RegisteredSubject, Registrations } from "./registration.js";
import { AttendanceMeta, AttendanceHeader, Semester } from "./attendance.js";
import { ExamEvent } from "./exam.js";
import { generate_local_name, serialize_payload } from "./encryption.js";

/**
 * @module Wrapper
 */
/**
 * Base API endpoint for the JIIT web portal
 * @constant {string}
 */
export const API = "https://webportal.jiit.ac.in:6011/StudentPortalAPI";

/**
 * Default CAPTCHA values used for login
 * @constant {{captcha: string, hidden: string}}
 */
export const DEFCAPTCHA = { captcha: "phw5n", hidden: "gmBctEffdSg=" };

/**
 * Class representing a session with the web portal
 */
export class WebPortalSession {
  /**
   * Creates a WebPortalSession instance from API response
   * @param {Object} resp - Response object from login API
   * @param {Object} resp.regdata - Registration data containing user details
   * @param {Array} resp.regdata.institutelist - List of institutes user has access to
   * @param {string} resp.regdata.memberid - Member ID of the user
   * @param {string} resp.regdata.userid - User ID
   * @param {string} resp.regdata.token - Token for authentication
   * @param {string} resp.regdata.clientid - Client ID
   * @param {string} resp.regdata.membertype - Type of member
   * @param {string} resp.regdata.name - Name of the user
   * @param {string} resp.regdata.enrollmentno - Enrollment number
   */
  constructor(resp) {
    this.raw_response = resp;
    this.regdata = resp["regdata"];

    let institute = this.regdata["institutelist"][0];
    this.institute = institute["label"];
    this.instituteid = institute["value"];
    this.memberid = this.regdata["memberid"];
    this.userid = this.regdata["userid"];

    this.token = this.regdata["token"];
    let expiry_timestamp = JSON.parse(atob(this.token.split(".")[1]))["exp"];
    this.expiry = new Date(expiry_timestamp * 1000); // In JavaScript, Date expects milliseconds

    this.clientid = this.regdata["clientid"];
    this.membertype = this.regdata["membertype"];
    this.name = this.regdata["name"];
    this.enrollmentno = this.regdata["enrollmentno"];
  }

  /**
   * Generates authentication headers for API requests
   * @returns {Promise<Object>} Headers object containing Authorization and LocalName
   */
  async get_headers() {
    const localname = await generate_local_name();
    return {
      Authorization: `Bearer ${this.token}`,
      LocalName: localname,
    };
  }
}

/**
 * Main class for interacting with the JIIT web portal API
 */
export class WebPortal {
  /**
   * Creates a WebPortal instance
   */
  constructor() {
    this.session = null;
  }

  /**
   * Internal method to make HTTP requests to the API
   * @private
   * @param {string} method - HTTP method (GET, POST etc)
   * @param {string} url - API endpoint URL
   * @param {Object} [options={}] - Request options
   * @param {Object} [options.headers] - Additional headers
   * @param {Object} [options.json] - JSON payload
   * @param {string} [options.body] - Raw body payload
   * @param {boolean} [options.authenticated] - Whether request needs authentication
   * @param {Error} [options.exception] - Custom error class to throw
   * @returns {Promise<Object>} API response
   * @throws {APIError} On API or network errors
   */
  async __hit(method, url, options = {}) {
    let exception = APIError; // Default exception
    if (options.exception) {
      exception = options.exception;
      delete options.exception;
    }

    console.log(options);
    let header;
    if (options.authenticated) {
      header = await this.session.get_headers(); // Assumes calling method is authenticated
      delete options.authenticated;
    } else {
      let localname = await generate_local_name();
      header = { LocalName: localname };
    }

    if (options.headers) {
      options.headers = { ...options.headers, ...header };
    } else {
      options.headers = header;
    }

    let fetchOptions = {
      method: method,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
    };

    if (options.json) {
      fetchOptions.body = JSON.stringify(options.json);
    } else {
      fetchOptions.body = options.body;
    }

    try {
      console.log("fetching", url, "with options", fetchOptions);
      const response = await fetch(url, fetchOptions);

      if (response.status === 513) {
        throw new exception("JIIT Web Portal server is temporarily unavailable (HTTP 513). Please try again later.");
      }
      if (response.status === 401) {
        throw new SessionExpired(response.error);
      }

      const resp = await response.json();

      if (resp.status && resp.status.responseStatus !== "Success") {
        throw new exception(`status:\n${JSON.stringify(resp.status, null, 2)}`);
      }
      return resp;
    } catch (error) {
      // Handle CORS errors
      if (error instanceof TypeError && error.message.includes("CORS")) {
        throw new exception("JIIT Web Portal server is temporarily unavailable. Please try again later.");
      }
      throw new exception(error.message || "Unknown error");
    }
  }

  /**
   * Logs in a student user
   * @param {string} username - Student username
   * @param {string} password - Student password
   * @param {{captcha: string, hidden: string}} [captcha=DEFCAPTCHA] - CAPTCHA
   * @returns {Promise<WebPortalSession>} New session instance
   * @throws {LoginError} On login failure
   */
  async student_login(username, password, captcha = DEFCAPTCHA) {
    let pretoken_endpoint = "/token/pretoken-check";
    let token_endpoint = "/token/generate-token1";

    let payload = { username: username, usertype: "S", captcha: captcha };
    payload = await serialize_payload(payload);

    let resp = await this.__hit("POST", API + pretoken_endpoint, { body: payload, exception: LoginError });

    let payload2 = resp["response"];
    delete payload2["rejectedData"];
    payload2["Modulename"] = "STUDENTMODULE";
    payload2["passwordotpvalue"] = password;
    payload2 = await serialize_payload(payload2);

    const resp2 = await this.__hit("POST", API + token_endpoint, { body: payload2, exception: LoginError });
    this.session = new WebPortalSession(resp2["response"]);
    return this.session;
  }

  /**
   * Gets personal information of logged in student
   * @returns {Promise<Object>} Student personal information
   */
  async get_personal_info() {
    const ENDPOINT = "/studentpersinfo/getstudent-personalinformation";
    const payload = {
      clinetid: "SOAU",
      instituteid: this.session.instituteid,
    };
    const resp = await this.__hit("POST", API + ENDPOINT, { json: payload, authenticated: true });
    return resp["response"];
  }

  /**
   * Gets bank account information of logged in student
   * @returns {Promise<Object>} Student bank information
   */
  async get_student_bank_info() {
    const ENDPOINT = "/studentbankdetails/getstudentbankinfo";
    const payload = {
      instituteid: this.session.instituteid,
      studentid: this.session.memberid,
    };
    const resp = await this.__hit("POST", API + ENDPOINT, { json: payload, authenticated: true });
    return resp["response"];
  }

  /**
   * Changes password for logged in student
   * @param {string} old_password - Current password
   * @param {string} new_password - New password
   * @returns {Promise<Object>} Response indicating success/failure
   * @throws {AccountAPIError} On password change failure
   */
  async change_password(old_password, new_password) {
    const ENDPOINT = "/clxuser/changepassword";
    const payload = {
      membertype: this.session.membertype,
      oldpassword: old_password,
      newpassword: new_password,
      confirmpassword: new_password,
    };
    const resp = await this.__hit("POST", API + ENDPOINT, {
      json: payload,
      authenticated: true,
      exception: AccountAPIError,
    });
    return resp["response"];
  }

  /**
   * Gets attendance metadata including headers and semesters
   * @returns {Promise<AttendanceMeta>} Attendance metadata
   */
  async get_attendance_meta() {
    const ENDPOINT = "/StudentClassAttendance/getstudentInforegistrationforattendence";

    const payload = {
      clientid: this.session.clientid,
      instituteid: this.session.instituteid,
      membertype: this.session.membertype,
    };

    const resp = await this.__hit("POST", API + ENDPOINT, { json: payload, authenticated: true });
    return new AttendanceMeta(resp["response"]);
  }

  /**
   * Gets attendance details for a semester
   * @param {AttendanceHeader} header - Attendance header
   * @param {Semester} semester - Semester object
   * @returns {Promise<Object>} Attendance details
   */
  async get_attendance(header, semester) {
    const ENDPOINT = "/StudentClassAttendance/getstudentattendancedetail";

    const payload = await serialize_payload({
      clientid: this.session.clientid,
      instituteid: this.session.instituteid,
      registrationcode: semester.registration_code,
      registrationid: semester.registration_id,
      stynumber: header.stynumber,
    });

    // console.log(payload)

    const resp = await this.__hit("POST", API + ENDPOINT, { json: payload, authenticated: true });
    return resp["response"];
  }

  /**
   * Gets attendance for every class of the subject for the semester.
   * @param {Semester} semester - Semester object
   * @param {string} subjectid - Subject ID
   * @param {string} individualsubjectcode - Individual subject code
   * @param {Array<string>} subjectcomponentids - Array of subject component IDs
   * @returns {Promise<Object>} Subject attendance details
   */
  async get_subject_daily_attendance(semester, subjectid, individualsubjectcode, subjectcomponentids) {
    const ENDPOINT = "/StudentClassAttendance/getstudentsubjectpersentage";
    const payload = await serialize_payload({
      cmpidkey: subjectcomponentids.map((id) => ({ subjectcomponentid: id })),
      clientid: this.session.clientid,
      instituteid: this.session.instituteid,
      registrationcode: semester.registration_code,
      registrationid: semester.registration_id,
      subjectcode: individualsubjectcode,
      subjectid: subjectid,
    });
    const resp = await this.__hit("POST", API + ENDPOINT, { json: payload, authenticated: true });
    return resp["response"];
  }

  /**
   * Gets list of registered semesters
   * @returns {Promise<Array<Semester>>} Array of semester objects
   */
  async get_registered_semesters() {
    const ENDPOINT = "/reqsubfaculty/getregistrationList";

    const payload = await serialize_payload({
      instituteid: this.session.instituteid,
      studentid: this.session.memberid,
    });
    const resp = await this.__hit("POST", API + ENDPOINT, { json: payload, authenticated: true });
    return resp["response"]["registrations"].map((i) => Semester.from_json(i));
  }

  /**
   * Gets registered subjects and faculty details for a semester
   * @param {Semester} semester - Semester object
   * @returns {Promise<Registrations>} Registration details
   */
  async get_registered_subjects_and_faculties(semester) {
    const ENDPOINT = "/reqsubfaculty/getfaculties";
    const payload = await serialize_payload({
      instituteid: this.session.instituteid,
      studentid: this.session.memberid,
      registrationid: semester.registration_id,
    });
    const resp = await this.__hit("POST", API + ENDPOINT, { json: payload, authenticated: true });
    return new Registrations(resp["response"]);
  }

  /**
   * Gets semesters that have exam events
   * @returns {Promise<Array<Semester>>} Array of semester objects
   */
  async get_semesters_for_exam_events() {
    const ENDPOINT = "/studentcommonsontroller/getsemestercode-withstudentexamevents";
    const payload = await serialize_payload({
      clientid: this.session.clientid,
      instituteid: this.session.instituteid,
      memberid: this.session.memberid,
    });

    const resp = await this.__hit("POST", API + ENDPOINT, { json: payload, authenticated: true });
    return resp["response"]["semesterCodeinfo"]["semestercode"].map((i) => Semester.from_json(i));
  }

  /**
   * Gets exam events for a semester
   * @param {Semester} semester - Semester object
   * @returns {Promise<Array<ExamEvent>>} Array of exam event objects
   */
  async get_exam_events(semester) {
    const ENDPOINT = "/studentcommonsontroller/getstudentexamevents";
    const payload = await serialize_payload({
      instituteid: this.session.instituteid,
      registationid: semester.registration_id, // not a typo
    });

    const resp = await this.__hit("POST", API + ENDPOINT, { json: payload, authenticated: true });
    return resp["response"]["eventcode"]["examevent"].map((i) => ExamEvent.from_json(i));
  }

  /**
   * Gets exam schedule for an exam event
   * @param {ExamEvent} exam_event - Exam event object
   * @returns {Promise<Object>} Exam schedule details
   */
  async get_exam_schedule(exam_event) {
    const ENDPOINT = "/studentsttattview/getstudent-examschedule";
    const payload = await serialize_payload({
      instituteid: this.session.instituteid,
      registrationid: exam_event.registration_id,
      exameventid: exam_event.exam_event_id,
    });
    const resp = await this.__hit("POST", API + ENDPOINT, { json: payload, authenticated: true });
    return resp["response"];
  }

  /**
   * Gets semesters that have marks available
   * @returns {Promise<Array<Semester>>} Array of semester objects
   */
  async get_semesters_for_marks() {
    const ENDPOINT = "/studentcommonsontroller/getsemestercode-exammarks";
    const payload = await serialize_payload({
      instituteid: this.session.instituteid,
      studentid: this.session.memberid,
    });
    const resp = await this.__hit("POST", API + ENDPOINT, { json: payload, authenticated: true });
    return resp["response"]["semestercode"].map((i) => Semester.from_json(i));
  }

  /**
   * Downloads marks PDF for a semester
   * @param {Semester} semester - Semester object
   * @throws {APIError} On download failure
   */
  async download_marks(semester) {
    const ENDPOINT =
      "/studentsexamview/printstudent-exammarks/" +
      // this.session.memberid +
      // "/" +
      this.session.instituteid +
      "/" +
      semester.registration_id +
      "/" +
      semester.registration_code;
    const localname = await generate_local_name();
    let _headers = await this.session.get_headers(localname);
    const fetchOptions = {
      method: "GET",
      headers: _headers,
    };

    try {
      const resp = await fetch(API + ENDPOINT, fetchOptions);
      const blob = await resp.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `marks_${semester.registration_code}.pdf`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();
    } catch (error) {
      throw new APIError(error);
    }
  }

  /**
   * Gets semesters that have grade cards available
   * @returns {Promise<Array<Semester>>} Array of semester objects
   */
  async get_semesters_for_grade_card() {
    const ENDPOINT = "/studentgradecard/getregistrationList";
    const payload = await serialize_payload({
      instituteid: this.session.instituteid,
    });
    const resp = await this.__hit("POST", API + ENDPOINT, { json: payload, authenticated: true });
    return resp["response"]["registrations"].map((i) => Semester.from_json(i));
  }

  /**
   * Gets program ID for grade card
   * @private
   * @returns {Promise<string>} Program ID
   */
  async __get_program_id() {
    const ENDPOINT = "/studentgradecard/getstudentinfo";
    const payload = await serialize_payload({
      instituteid: this.session.instituteid,
    });
    const resp = await this.__hit("POST", API + ENDPOINT, { json: payload, authenticated: true });
    return resp["response"]["programid"];
  }

  /**
   * Gets grade card for a semester
   * @param {Semester} semester - Semester object
   * @returns {Promise<Object>} Grade card details
   */
  async get_grade_card(semester) {
    const programid = await this.__get_program_id();
    const ENDPOINT = "/studentgradecard/showstudentgradecard";
    const payload = await serialize_payload({
      branchid: this.session.branch_id,
      instituteid: this.session.instituteid,
      programid: programid,
      registrationid: semester.registration_id,
    });
    const resp = await this.__hit("POST", API + ENDPOINT, { json: payload, authenticated: true });
    return resp["response"];
  }

  /**
   * Gets current semester number
   * @private
   * @returns {Promise<number>} Current semester number
   */
  async __get_semester_number() {
    const ENDPOINT = "/studentsgpacgpa/checkIfstudentmasterexist";
    const payload = await serialize_payload({
      instituteid: this.session.instituteid,
      studentid: this.session.memberid,
      name: this.session.name,
      enrollmentno: this.session.enrollmentno,
    });
    const resp = await this.__hit("POST", API + ENDPOINT, { json: payload, authenticated: true });
    return resp["response"]["studentlov"]["currentsemester"];
  }

  /**
   * Gets SGPA and CGPA details
   * @returns {Promise<Object>} SGPA and CGPA details
   */
  async get_sgpa_cgpa() {
    const ENDPOINT = "/studentsgpacgpa/getallsemesterdata";
    const stynumber = await this.__get_semester_number();
    const payload = await serialize_payload({
      instituteid: this.session.instituteid,
      studentid: this.session.memberid,
      stynumber: stynumber,
    });
    const resp = await this.__hit("POST", API + ENDPOINT, { json: payload, authenticated: true });
    return resp["response"];
  }

  /**
   * Gets pending miscellaneous charges/fines for the logged-in student
   * @returns {Promise<Object>} The raw 'response' dict from the API.
   *                           If there are no pending payments, the API returns
   *                           status: Failure with error "NO APPROVED REQUEST FOUND".
   * @throws {APIError} On any non-Success responseStatus
   */
  async get_fines_msc_charges() {
    const ENDPOINT = "/collectionpendingpayments/getpendingpaymentsdata";
    const payload = await serialize_payload({
      instituteid: this.session.instituteid,
      studentid: this.session.memberid,
    });
    const resp = await this.__hit("POST", API + ENDPOINT, { json: payload, authenticated: true });
    return resp["response"];
  }

  /**
   * Gets the fee summary for the logged-in student
   * @returns {Promise<Object>} The raw 'response' dict from the API
   * @throws {APIError} On any non-Success responseStatus
   */
  async get_fee_summary() {
    const ENDPOINT = "/studentfeeledger/loadfeesummary";
    const payload = {
      instituteid: this.session.instituteid,
    };
    const resp = await this.__hit("POST", API + ENDPOINT, { json: payload, authenticated: true });
    return resp["response"];
  }

  /**
   * Gets subject choices for a semester
   * @param {Semester} semester - A Semester object
   * @returns {Promise<Object>} A dictionary with subject choices data
   * @throws {APIError} Raised for generic API error
   */
  async get_subject_choices(semester) {
    const ENDPOINT = "/studentchoiceprint/getsubjectpreference";
    const payload = {
      instituteid: this.session.instituteid,
      studentid: this.session.memberid,
      registrationid: semester.registration_id,
    };
    const resp = await this.__hit("POST", API + ENDPOINT, { json: payload, authenticated: true });
    return resp["response"];
  }

  async get_hostel_details() {
    const ENDPOINT = "/myhostelallocationdetail/gethostelallocationdetail";
    const payload = {
      clientid: this.session.clientid,
      instituteid: this.session.instituteid,
      studentid: this.session.memberid,
    };

    const resp = await this.__hit("POST", API + ENDPOINT, { json: payload, authenticated: true });

    if (!resp?.response) {
      throw new Error("Hostel details not found");
    }

    return resp.response;
  }

  async fill_feedback_form(feedback_option) {
    const SEMESTER_ENDPOINT = "/feedbackformcontroller/getFeedbackEvent";
    const payload = {
      instituteid: this.session.instituteid,
    };
    const resp = await this.__hit("POST", API + SEMESTER_ENDPOINT, { json: payload, authenticated: true });
    let semesters = resp["response"]["eventList"];
    let latest_semester = semesters[semesters.length - 1];
    let latest_semester_code = latest_semester["eventcode"];
    let latest_semester_event_id = latest_semester["eventid"];
    let latest_semester_event_description = latest_semester["eventdescription"];

    const GRID_ENDPOINT = "/feedbackformcontroller/getGriddataForFeedback";
    const grid_payload = await serialize_payload({
      instituteid: this.session.instituteid,
      studentid: this.session.memberid,
      eventid: latest_semester_event_id,
    });
    const grid_resp = await this.__hit("POST", API + GRID_ENDPOINT, { json: grid_payload, authenticated: true });
    let grid_data = grid_resp["response"]["gridData"];

    // instituteid
    // eventid
    // eventdescription
    let question_feedback_payload_array = grid_data.map((data) => {
      return {
        instituteid: this.session.instituteid,
        eventid: latest_semester_event_id,
        eventdescription: latest_semester_event_description,
        facultyid: data["employeeid"],
        facultyname: data["employeename"],
        registrationid: data["registrationid"],
        studentid: data["studentid"],
        subjectcode: data["subjectcode"],
        subjectcomponentcode: data["subjectcomponentcode"],
        subjectcomponentid: data["subjectcomponentid"],
        subjectdescription: data["subjectdescription"],
        subjectid: data["subjectid"],
      };
    });
    const GET_QUESTIONS_ENDPOINT = "/feedbackformcontroller/getIemQuestion";
    const SAVE_ENDPOINT = "/feedbackformcontroller/savedatalist";

    for (let question_feedback_payload of question_feedback_payload_array) {
      try {
        const questions_api_resp = await this.__hit("POST", API + GET_QUESTIONS_ENDPOINT, {
          json: question_feedback_payload,
          authenticated: true,
        });
      } catch (error) {
        continue;
      }

      // Process the response to get the list of questions
      if (!questions_api_resp || !questions_api_resp.response || !questions_api_resp.response.questionList) {
        console.error(
          "Failed to retrieve question list or invalid response structure for payload:",
          question_feedback_payload,
          "Response:",
          questions_api_resp
        );
        // Skip to the next feedback item if data is missing
        continue;
      }
      let actual_question_list = questions_api_resp["response"]["questionList"];

      // Update each question with the provided feedback_option
      let questions_to_submit = actual_question_list.map((q) => ({
        ...q, // Spread existing question properties
        rating: feedback_option, // Set the rating using the function's argument
      }));

      // Construct the payload for saving the feedback
      let save_data_payload = {
        instituteid: question_feedback_payload.instituteid, // This comes from this.session.instituteid via map
        studentid: this.session.memberid, // Logged-in user's ID
        eventid: question_feedback_payload.eventid, // This comes from latest_semester_event_id via map
        subjectid: question_feedback_payload.subjectid, // From the specific grid item
        facultyid: question_feedback_payload.facultyid, // From the specific grid item
        registrationid: question_feedback_payload.registrationid, // From the specific grid item
        questionid: questions_to_submit, // The list of questions with updated ratings
        facultycomments: null, // Defaulting to null; can be parameterized if needed
        coursecomments: null, // Defaulting to null; can be parameterized if needed
      };
      save_data_payload = await serialize_payload(save_data_payload);

      // Send the feedback data to the SAVE_ENDPOINT
      await this.__hit("POST", API + SAVE_ENDPOINT, {
        json: save_data_payload,
        authenticated: true,
      });
      // Optionally, collect or handle the response from SAVE_ENDPOINT
    }
  }
}

/**
 * Decorator that checks if user is authenticated before executing method
 * @param {Function} method - Method to decorate
 * @returns {Function} Decorated method that checks authentication
 * @throws {NotLoggedIn} If user is not logged in
 */
function authenticated(method) {
  return function (...args) {
    if (this.session == null) {
      throw new NotLoggedIn();
    }
    return method.apply(this, args);
  };
}

/**
 * List of methods that require authentication
 * @constant {Array<string>}
 */
const authenticatedMethods = [
  "get_personal_info",
  "get_student_bank_info",
  "change_password",
  "get_attendance_meta",
  "get_attendance",
  "get_subject_daily_attendance",
  "get_registered_semesters",
  "get_registered_subjects_and_faculties",
  "get_semesters_for_exam_events",
  "get_exam_events",
  "get_exam_schedule",
  "get_semesters_for_marks",
  "download_marks",
  "get_semesters_for_grade_card",
  "__get_program_id",
  "get_grade_card",
  "__get_semester_number",
  "get_sgpa_cgpa",
  "get_hostel_details",
  "get_fines_msc_charges",
  "get_fee_summary",
  "get_subject_choices",
];

authenticatedMethods.forEach((methodName) => {
  WebPortal.prototype[methodName] = authenticated(WebPortal.prototype[methodName]);
});
