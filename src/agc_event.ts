export class AGCEvent {
  constructor(public code: string, public message: string, public timestamp: number, public task_id: number | null, public context: object) {
    
  }
}
