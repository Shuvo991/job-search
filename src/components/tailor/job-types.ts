/** The few job fields the browser needs; the server loads the full posting by id. */
export interface TailorJob {
  id: string;
  title: string;
  company: string;
  skills: string[];
}
